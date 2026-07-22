// SPDX-License-Identifier: MIT
//
// The streaming-STT deep module. Owns the lifecycle adapters used to re-implement:
// context tracking, outbound audio send + finalize, transcript funnel (interim/final),
// usage delta-billing at finals, and optional eos.turn_complete. Socket-free: depends
// only on injected ports so the funnel is unit-testable without a real WebSocket.

import {
  Route,
  assertAudioPayload,
  categorizeSttError,
  isRecoverable,
  type AudioFormat,
  type SttErrorPacket,
  type SttInterimPacket,
  type SttResultPacket,
} from "@kuralle-syrinx/core";
import type { SocketData } from "@kuralle-syrinx/ws";

import type { PacketSink, SttEvent, SttWireProtocol, Transport } from "./types.js";

export interface SttEngineDeps {
  readonly protocol: SttWireProtocol;
  readonly transport: Transport;
  readonly sink: PacketSink;
  readonly provider: { readonly name: string; readonly model: string; readonly region?: string };
  /** When true, emit `eos.turn_complete` for finals with `speechFinal: true`. */
  readonly emitEosOnFinal: boolean;
  /** Default language stamped on `stt.result` when the event omits one. */
  readonly language: string;
  /** When set, outbound audio is validated with `assertAudioPayload` before send. */
  readonly format?: AudioFormat;
  readonly now?: () => number;
}

export interface SttEngine {
  onAudio(audio: Uint8Array, contextId?: string): Promise<boolean>;
  onFinalize(contextId?: string): Promise<void>;
  onTurnChange(contextId: string): void;
  onInterrupt(): void;
  onMessage(data: SocketData, isBinary: boolean): void;
  onConnectionLost(error: Error): void;
  close(): Promise<void>;
  readonly currentContextId: string;
}

export function createSttEngine(deps: SttEngineDeps): SttEngine {
  return new SttEngineImpl(deps);
}

/** Cap the pre-handshake audio buffer so a never-ready session cannot grow it unbounded. */
const MAX_PENDING_AUDIO_FRAMES = 256;

class SttEngineImpl implements SttEngine {
  private contextId = "";
  /** Cumulative billed audio-seconds per context (provider duration is often cumulative). */
  private readonly billedDurationByContextId = new Map<string, number>();
  /** Audio that arrived before the provider handshake (isReady()) — flushed on the ready transition. */
  private readonly pendingAudio: Uint8Array[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: SttEngineDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get currentContextId(): string {
    return this.contextId;
  }

  async onAudio(audio: Uint8Array, contextId?: string): Promise<boolean> {
    if (contextId) this.contextId = contextId;
    if (audio.byteLength === 0) return true;
    try {
      if (this.deps.format) assertAudioPayload(this.deps.format, audio);
      await this.deps.transport.ensureReady();
      // Buffer (don't drop) audio that races ahead of the provider handshake (e.g. Grok's
      // transcript.created); the pending frames flush on the isReady() transition in onMessage.
      // Prevents losing the start of speech and the pre-handshake send/receive race.
      if (this.deps.protocol.isReady && !this.deps.protocol.isReady()) {
        this.pendingAudio.push(audio);
        if (this.pendingAudio.length > MAX_PENDING_AUDIO_FRAMES) this.pendingAudio.shift();
        return true;
      }
      this.flushPendingAudioIfReady(); // drain anything buffered before the handshake, in order
      this.deps.transport.send(audio);
      return true;
    } catch (err) {
      this.emitError(this.contextId, err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  async onFinalize(contextId?: string): Promise<void> {
    const ctx = contextId ?? this.contextId;
    try {
      await this.deps.transport.ensureReady();
      if (this.deps.transport.isReady === false) return;
      for (const frame of this.deps.protocol.encodeFinalize(ctx)) {
        this.deps.transport.send(frame);
      }
    } catch (err) {
      this.emitError(ctx, err instanceof Error ? err : new Error(String(err)));
    }
  }

  onTurnChange(nextContextId: string): void {
    if (this.contextId && this.contextId !== nextContextId) {
      this.billedDurationByContextId.delete(this.contextId);
    }
    this.contextId = nextContextId;
  }

  onInterrupt(): void {
    if (this.contextId) this.billedDurationByContextId.delete(this.contextId);
    this.contextId = "";
  }

  onMessage(data: SocketData, isBinary: boolean): void {
    let events: readonly SttEvent[];
    try {
      events = this.deps.protocol.decode(data, isBinary);
    } catch (err) {
      this.emitError(this.contextId, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const event of events) this.dispatch(event);
    this.flushPendingAudioIfReady();
  }

  private flushPendingAudioIfReady(): void {
    if (this.pendingAudio.length === 0) return;
    if (this.deps.protocol.isReady && !this.deps.protocol.isReady()) return;
    const frames = this.pendingAudio.splice(0);
    try {
      for (const audio of frames) this.deps.transport.send(audio);
    } catch (err) {
      this.emitError(this.contextId, err instanceof Error ? err : new Error(String(err)));
    }
  }

  onConnectionLost(error: Error): void {
    this.deps.protocol.onConnectionLost?.();
    this.emitError(this.contextId, error);
  }

  async close(): Promise<void> {
    this.billedDurationByContextId.clear();
    this.pendingAudio.length = 0;
    try {
      const frames = this.deps.protocol.encodeClose?.() ?? [];
      if (frames.length > 0) {
        await this.deps.transport.ensureReady();
        if (this.deps.transport.isReady !== false) {
          for (const frame of frames) this.deps.transport.send(frame);
        }
      }
    } catch {
      // Best-effort session shutdown.
    }
    await this.deps.transport.close();
  }

  private dispatch(event: SttEvent): void {
    switch (event.type) {
      case "interim":
        this.handleInterim(event);
        return;
      case "final":
        this.handleFinal(event);
        return;
      case "error":
        this.emitError(event.contextId || this.contextId, event.error);
        return;
      case "ignore":
        return;
    }
  }

  private handleInterim(event: Extract<SttEvent, { type: "interim" }>): void {
    const text = event.text.trim();
    if (!text) return;
    const contextId = event.contextId || this.contextId;
    const packet: SttInterimPacket = {
      kind: "stt.interim",
      contextId,
      timestampMs: this.now(),
      text,
    };
    this.deps.sink.push(Route.Main, packet);
  }

  private handleFinal(event: Extract<SttEvent, { type: "final" }>): void {
    const text = event.text.trim();
    if (!text) return;
    const contextId = event.contextId || this.contextId;
    const providerBase = {
      name: this.deps.provider.name,
      model: this.deps.provider.model,
      region: this.deps.provider.region ?? "global",
    };
    const packet: SttResultPacket = {
      kind: "stt.result",
      contextId,
      timestampMs: this.now(),
      text,
      confidence: event.confidence ?? 0,
      language: event.language ?? this.deps.language,
      provider: event.provider ? { ...providerBase, ...event.provider } : providerBase,
    };
    this.deps.sink.push(Route.Main, packet);
    // Bill at the final-result funnel so usage fires under smart-turn endpointing too.
    this.emitSttUsage(contextId, event.audioSeconds);
    if (this.deps.emitEosOnFinal && event.speechFinal) {
      this.deps.sink.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId,
        timestampMs: this.now(),
        text,
        transcripts: [],
      });
    }
  }

  /**
   * Bill only the unbilled audio-seconds delta per context (smart-turn-safe). Provider
   * `audioSeconds` is treated as cumulative-from-stream-start when it grows across finals.
   */
  private emitSttUsage(contextId: string, duration: number | undefined): void {
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return;
    const billed = this.billedDurationByContextId.get(contextId) ?? 0;
    const audioSeconds = duration - billed;
    if (audioSeconds <= 0) return;
    this.billedDurationByContextId.set(contextId, duration);
    this.deps.sink.push(Route.Background, {
      kind: "usage.recorded",
      contextId,
      timestampMs: this.now(),
      stage: "stt",
      provider: this.deps.provider.name,
      model: this.deps.provider.model,
      audioSeconds,
    });
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeSttError(err);
    const packet: SttErrorPacket = {
      kind: "stt.error",
      contextId,
      timestampMs: this.now(),
      component: "stt",
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.deps.sink.push(Route.Critical, packet);
  }
}
