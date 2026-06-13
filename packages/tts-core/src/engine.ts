// SPDX-License-Identifier: MIT
//
// The streaming-TTS deep module. Owns the entire lifecycle that the cartesia/grok/epsilon
// plugins each used to duplicate: per-key PCM16 carry, active/cancelled/pending-end
// bookkeeping keyed on the provider's opaque attribution key, finish-timeout, error
// categorization, packet emission, and connection-loss failure. Socket-free: depends only
// on the injected ports (`WireProtocol`, `Transport`, `PacketSink`, `TimerPort`), so the
// tricky behavior (odd-byte carry, multiplex refcount, cancel races, finish-timeout) is
// unit-testable without a real WebSocket.

import {
  Route,
  assertAudioPayload,
  categorizeTtsError,
  isRecoverable,
  type AudioFormat,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
} from "@kuralle-syrinx/core";
import type { SocketData } from "@kuralle-syrinx/ws";

import type { AttributionKey, PacketSink, TimerHandle, TimerPort, Transport, WireProtocol } from "./types.js";

const EMPTY = new Uint8Array(0);

const defaultTimer: TimerPort = {
  set: (ms, fn) => setTimeout(fn, ms),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface TtsEngineDeps {
  readonly protocol: WireProtocol;
  readonly transport: Transport;
  readonly sink: PacketSink;
  readonly format: AudioFormat;
  readonly sampleRateHz: number;
  readonly provider: { readonly name: string; readonly model: string; readonly region?: string };
  /** 0 disables the finish-timeout fallback. */
  readonly finishTimeoutMs: number;
  /** Namespace for engine-emitted metrics, e.g. "tts.epsilon". */
  readonly metricPrefix: string;
  readonly timer?: TimerPort;
  readonly now?: () => number;
}

export interface TtsEngine {
  onText(text: string, contextId: string): Promise<void>;
  onDone(contextId: string): Promise<void>;
  onInterrupt(): Promise<void>;
  onMessage(data: SocketData, isBinary: boolean): void;
  onConnectionLost(error: Error): void;
  close(): Promise<void>;
}

export function createTtsEngine(deps: TtsEngineDeps): TtsEngine {
  return new TtsEngineImpl(deps);
}

class TtsEngineImpl implements TtsEngine {
  private readonly keyToContext = new Map<AttributionKey, string>();
  private readonly contextKeys = new Map<string, Set<AttributionKey>>();
  private readonly cancelledContexts = new Set<string>();
  private readonly cancelledKeys = new Set<AttributionKey>();
  private readonly carry = new Map<AttributionKey, Uint8Array>();
  private readonly pendingEnd = new Set<string>();
  private readonly finishTimers = new Map<string, TimerHandle>();
  private readonly timer: TimerPort;
  private readonly now: () => number;

  constructor(private readonly deps: TtsEngineDeps) {
    this.timer = deps.timer ?? defaultTimer;
    this.now = deps.now ?? (() => Date.now());
  }

  async onText(text: string, contextId: string): Promise<void> {
    if (!text.trim()) return;
    if (this.cancelledContexts.has(contextId)) return;
    const { key } = this.deps.protocol.attributionFor(contextId);
    this.track(key, contextId);
    const frames = this.deps.protocol.encodeText(key, text);
    if (frames.length === 0) {
      this.untrack(key);
      return;
    }
    for (const frame of frames) {
      if (!(await this.trySend(frame, contextId))) {
        this.untrack(key);
        return;
      }
    }
  }

  async onDone(contextId: string): Promise<void> {
    if (this.cancelledContexts.has(contextId)) return;
    const activeKeys = [...(this.contextKeys.get(contextId) ?? [])];
    for (const frame of this.deps.protocol.encodeFinish(contextId, activeKeys)) {
      await this.trySend(frame, contextId);
    }
    this.pendingEnd.add(contextId);
    if (this.deps.finishTimeoutMs > 0 && this.hasActiveKeys(contextId)) {
      this.scheduleFinishTimeout(contextId);
    }
    this.tryEmitEnd(contextId);
  }

  async onInterrupt(): Promise<void> {
    const contexts = new Set<string>([...this.contextKeys.keys(), ...this.pendingEnd]);
    for (const contextId of contexts) await this.cancelContext(contextId);
  }

  onMessage(data: SocketData, isBinary: boolean): void {
    let event;
    try {
      event = this.deps.protocol.decode(data, isBinary);
    } catch (err) {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    switch (event.type) {
      case "audio":
        this.handleAudio(event.key, event.pcm);
        return;
      case "utterance_end":
        this.handleUtteranceEnd(event.key);
        return;
      case "cancelled":
        this.cancelledKeys.delete(event.key);
        this.untrack(event.key);
        return;
      case "error":
        this.handleError(event.key, event.error);
        return;
      case "sideband": {
        const contextId = this.keyToContext.get(event.key);
        if (contextId === undefined) return;
        this.deps.sink.push(event.route, event.build(contextId, this.now()));
        return;
      }
      case "ignore":
        return;
    }
  }

  onConnectionLost(error: Error): void {
    this.failAll(error);
  }

  async close(): Promise<void> {
    this.pendingEnd.clear();
    this.cancelledContexts.clear();
    this.cancelledKeys.clear();
    this.keyToContext.clear();
    this.contextKeys.clear();
    this.carry.clear();
    for (const handle of this.finishTimers.values()) this.timer.clear(handle);
    this.finishTimers.clear();
    try {
      for (const frame of this.deps.protocol.encodeClose()) {
        await this.deps.transport.ensureReady();
        this.deps.transport.send(frame);
      }
    } catch {
      // Best-effort session shutdown.
    }
    await this.deps.transport.close();
  }

  // ── inbound handling ──────────────────────────────────────────────────────

  private handleAudio(key: AttributionKey, pcm: Uint8Array): void {
    const contextId = this.keyToContext.get(key);
    if (contextId === undefined || this.cancelledContexts.has(contextId) || this.cancelledKeys.has(key)) {
      return;
    }
    if (pcm.byteLength === 0) return;

    const prev = this.carry.get(key) ?? EMPTY;
    const buf = prev.byteLength === 0 ? pcm : concatBytes(prev, pcm);
    const evenLen = buf.byteLength - (buf.byteLength % 2);
    if (evenLen > 0) {
      const audio = buf.subarray(0, evenLen);
      try {
        assertAudioPayload(this.deps.format, audio);
      } catch (err) {
        this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const packet: TextToSpeechAudioPacket = {
        kind: "tts.audio",
        contextId,
        timestampMs: this.now(),
        audio,
        sampleRateHz: this.deps.sampleRateHz,
        provider: {
          name: this.deps.provider.name,
          model: this.deps.provider.model,
          region: this.deps.provider.region ?? "global",
          cancelled: false,
        },
      };
      this.deps.sink.push(Route.Main, packet);
    }
    this.carry.set(key, evenLen < buf.byteLength ? buf.subarray(evenLen) : EMPTY);
  }

  private handleUtteranceEnd(key: AttributionKey): void {
    const contextId = this.keyToContext.get(key);
    this.cancelledKeys.delete(key);
    this.untrack(key);
    if (contextId === undefined || this.cancelledContexts.has(contextId)) return;
    this.tryEmitEnd(contextId);
  }

  private handleError(key: AttributionKey | null, error: Error): void {
    const contextId = key !== null ? this.keyToContext.get(key) : undefined;
    if (key !== null) this.untrack(key);
    if (contextId !== undefined && this.cancelledContexts.has(contextId)) return;
    this.emitError(contextId ?? "", error);
    if (contextId !== undefined) this.tryEmitEnd(contextId);
  }

  // ── bookkeeping ───────────────────────────────────────────────────────────

  private track(key: AttributionKey, contextId: string): void {
    this.keyToContext.set(key, contextId);
    let keys = this.contextKeys.get(contextId);
    if (!keys) {
      keys = new Set();
      this.contextKeys.set(contextId, keys);
    }
    keys.add(key);
  }

  private untrack(key: AttributionKey): void {
    const contextId = this.keyToContext.get(key);
    this.keyToContext.delete(key);
    this.carry.delete(key);
    if (contextId === undefined) return;
    const keys = this.contextKeys.get(contextId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.contextKeys.delete(contextId);
  }

  private hasActiveKeys(contextId: string): boolean {
    return (this.contextKeys.get(contextId)?.size ?? 0) > 0;
  }

  private async cancelContext(contextId: string): Promise<void> {
    this.cancelledContexts.add(contextId);
    this.pendingEnd.delete(contextId);
    this.clearFinishTimeout(contextId);
    for (const key of [...(this.contextKeys.get(contextId) ?? [])]) {
      this.cancelledKeys.add(key);
      for (const frame of this.deps.protocol.encodeCancel(key, contextId)) {
        await this.trySend(frame, contextId);
      }
    }
  }

  private tryEmitEnd(contextId: string): void {
    if (!this.pendingEnd.has(contextId)) return;
    if (this.hasActiveKeys(contextId)) return;
    this.pendingEnd.delete(contextId);
    this.clearFinishTimeout(contextId);
    this.cancelledContexts.delete(contextId);
    this.emitEnd(contextId);
  }

  private failAll(error: Error): void {
    const contexts = new Set<string>([...this.contextKeys.keys(), ...this.pendingEnd]);
    this.pendingEnd.clear();
    this.contextKeys.clear();
    this.keyToContext.clear();
    this.carry.clear();
    for (const contextId of contexts) {
      this.clearFinishTimeout(contextId);
      this.emitError(contextId, error);
    }
  }

  // ── timers ────────────────────────────────────────────────────────────────

  private scheduleFinishTimeout(contextId: string): void {
    this.clearFinishTimeout(contextId);
    const handle = this.timer.set(this.deps.finishTimeoutMs, () => {
      this.finishTimers.delete(contextId);
      if (!this.pendingEnd.has(contextId) && !this.hasActiveKeys(contextId)) return;
      this.emitMetric(contextId, `${this.deps.metricPrefix}.finish_timeout`, String(this.deps.finishTimeoutMs));
      this.pendingEnd.delete(contextId);
      for (const key of [...(this.contextKeys.get(contextId) ?? [])]) this.untrack(key);
      this.cancelledContexts.delete(contextId);
      this.emitEnd(contextId);
    });
    this.finishTimers.set(contextId, handle);
  }

  private clearFinishTimeout(contextId: string): void {
    const handle = this.finishTimers.get(contextId);
    if (handle === undefined) return;
    this.timer.clear(handle);
    this.finishTimers.delete(contextId);
  }

  // ── emission ──────────────────────────────────────────────────────────────

  private async trySend(frame: SocketData, contextId: string): Promise<boolean> {
    try {
      await this.deps.transport.ensureReady();
      this.deps.transport.send(frame);
      return true;
    } catch (err) {
      this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  private emitEnd(contextId: string): void {
    this.deps.sink.push(Route.Main, {
      kind: "tts.end",
      contextId,
      timestampMs: this.now(),
    } satisfies TextToSpeechEndPacket);
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeTtsError(err);
    const packet: TtsErrorPacket = {
      kind: "tts.error",
      contextId,
      timestampMs: this.now(),
      component: "tts",
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.deps.sink.push(Route.Critical, packet);
  }

  private emitMetric(contextId: string, name: string, value: string): void {
    this.deps.sink.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: this.now(),
      name,
      value,
    });
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
