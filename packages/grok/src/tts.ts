// SPDX-License-Identifier: MIT

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  Route,
  type AudioFormat,
  type PluginConfig,
  type RetryConfig,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
  type VoicePlugin,
  assertAudioFormat,
  assertAudioPayload,
  categorizeTtsError,
  isRecoverable,
  optionalStringConfig,
  readProviderRetryConfig,
  requireStringConfig,
} from "@kuralle-syrinx/core";
import { WebSocketConnection, type SocketFactory } from "@kuralle-syrinx/ws";

import { base64ToBytes } from "@kuralle-syrinx/realtime";

const KEEP_ALIVE_INTERVAL_MS = 10_000;
const EMPTY = new Uint8Array(0);

export class GrokTTSPlugin implements VoicePlugin {
  constructor(private readonly socketFactory?: SocketFactory) {}

  private bus: PipelineBus | null = null;
  private conn: WebSocketConnection | null = null;
  private apiKey = "";
  private voiceId = "eve";
  private language = "en";
  private endpointUrl = "wss://api.x.ai/v1/tts";
  private sampleRate = 16000;
  private retryConfig: RetryConfig = readProviderRetryConfig({});
  private currentContextId = "";
  private carry: Uint8Array = EMPTY;
  private activeContexts = new Set<string>();
  private cancelledContexts = new Set<string>();
  private clearedPending = false;
  private finishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposers: Array<() => void> = [];
  private audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.voiceId = optionalStringConfig(config, "voice_id") ?? this.voiceId;
    this.language = optionalStringConfig(config, "language") ?? this.language;
    this.endpointUrl = optionalStringConfig(config, "endpoint_url") ?? this.endpointUrl;
    this.sampleRate = readPositiveInteger(config["sample_rate"], this.sampleRate);
    this.retryConfig = readProviderRetryConfig(config);
    const finishTimeoutMs = readNonNegativeInteger(config["finish_timeout_ms"], 2000);
    this.audioFormat = { encoding: "pcm_s16le", sampleRateHz: this.sampleRate, channels: 1 };
    assertAudioFormat(this.audioFormat);

    this.conn = new WebSocketConnection({
      url: () => {
        const params = new URLSearchParams({
          language: this.language,
          voice: this.voiceId,
          codec: "pcm",
          sample_rate: String(this.sampleRate),
        });
        const separator = this.endpointUrl.includes("?") ? "&" : "?";
        return `${this.endpointUrl}${separator}${params.toString()}`;
      },
      headers: { Authorization: `Bearer ${this.apiKey}` },
      retry: this.retryConfig,
      socketFactory: this.socketFactory ?? (await defaultSocketFactory()),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 32,
      keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
      onMessage: (data) => this.handleProviderMessage(data),
      onConnectionLost: (err) => this.failActiveContexts(err),
      onUnrecoverable: (err) => this.failActiveContexts(err),
    });
    await this.conn.connect();

    this.disposers.push(
      bus.on("tts.text", async (pkt: unknown) => {
        const textPkt = pkt as { text: string; contextId: string };
        await this.speak(textPkt.text, textPkt.contextId);
      }),
      bus.on("tts.done", async (pkt: unknown) => {
        const donePkt = pkt as { contextId: string };
        if (finishTimeoutMs > 0 && this.activeContexts.has(donePkt.contextId)) {
          this.scheduleFinishTimeout(donePkt.contextId, finishTimeoutMs);
        }
        await this.finishContext(donePkt.contextId);
      }),
      bus.on("interrupt.tts", () => {
        this.cancelActiveContexts().catch(() => {
          // Best-effort interruption.
        });
      }),
    );
  }

  private async speak(text: string, contextId: string): Promise<void> {
    if (!text.trim()) return;
    if (this.cancelledContexts.has(contextId)) return;
    this.activeContexts.add(contextId);
    this.currentContextId = contextId;
    const sent = await this.trySend(JSON.stringify({ type: "text.delta", delta: text }), contextId);
    if (!sent) this.activeContexts.delete(contextId);
  }

  private async finishContext(contextId: string): Promise<void> {
    if (this.cancelledContexts.has(contextId)) return;
    if (!this.activeContexts.has(contextId)) {
      this.emitEnd(contextId);
      return;
    }
    if (!(await this.trySend(JSON.stringify({ type: "text.done" }), contextId))) {
      this.activeContexts.delete(contextId);
    }
  }

  async flush(): Promise<void> {
    await this.cancelActiveContexts();
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.activeContexts.clear();
    this.cancelledContexts.clear();
    for (const timer of this.finishTimers.values()) clearTimeout(timer);
    this.finishTimers.clear();
    this.currentContextId = "";
    this.carry = EMPTY;
    this.clearedPending = false;
    await this.conn?.close();
    this.conn = null;
    this.bus = null;
  }

  private async cancelActiveContexts(): Promise<void> {
    const contextIds = [...this.activeContexts];
    for (const contextId of contextIds) this.cancelledContexts.add(contextId);
    this.activeContexts.clear();
    for (const contextId of contextIds) this.clearFinishTimeout(contextId);
    this.currentContextId = "";
    this.carry = EMPTY;
    if (contextIds.length === 0) return;
    this.clearedPending = await this.trySend(JSON.stringify({ type: "text.clear" }), contextIds.at(-1) ?? "");
  }

  private async trySend(payload: string, contextId: string): Promise<boolean> {
    try {
      await this.conn?.ensureReady();
      this.conn?.send(payload);
      return true;
    } catch (err) {
      this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  private handleProviderMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg["type"]) {
      case "audio.delta":
        this.handleAudioDelta(msg);
        return;
      case "audio.done": {
        const contextId = this.currentContextId;
        this.carry = EMPTY;
        if (contextId && this.activeContexts.has(contextId)) {
          this.activeContexts.delete(contextId);
          this.clearFinishTimeout(contextId);
          this.emitEnd(contextId);
        }
        this.currentContextId = "";
        return;
      }
      case "audio.clear":
        this.carry = EMPTY;
        this.clearedPending = false;
        return;
      case "error":
        this.emitError(this.currentContextId, grokProviderError(msg));
        return;
      default:
        return;
    }
  }

  private handleAudioDelta(msg: Record<string, unknown>): void {
    const contextId = this.currentContextId;
    if (!contextId || this.clearedPending || this.cancelledContexts.has(contextId)) return;
    const delta = typeof msg["delta"] === "string" ? msg["delta"] : "";
    if (delta.length === 0) return;

    let frame: Uint8Array;
    try {
      frame = base64ToBytes(delta);
    } catch (err) {
      this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (frame.byteLength === 0) return;

    const buf = this.carry.byteLength === 0 ? frame : concatBytes(this.carry, frame);
    const evenLen = buf.byteLength - (buf.byteLength % 2);
    if (evenLen > 0) {
      const audio = buf.subarray(0, evenLen);
      try {
        assertAudioPayload(this.audioFormat, audio);
      } catch (err) {
        this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const packet: TextToSpeechAudioPacket = {
        kind: "tts.audio",
        contextId,
        timestampMs: Date.now(),
        audio,
        sampleRateHz: this.sampleRate,
        provider: { name: "grok", model: this.voiceId, region: "global", cancelled: false },
      };
      this.bus?.push(Route.Main, packet);
    }
    this.carry = evenLen < buf.byteLength ? buf.subarray(evenLen) : EMPTY;
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeTtsError(err);
    const packet: TtsErrorPacket = {
      kind: "tts.error",
      contextId,
      timestampMs: Date.now(),
      component: "tts",
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.bus?.push(Route.Critical, packet);
  }

  private failActiveContexts(err: Error): void {
    const contextIds = [...this.activeContexts];
    this.activeContexts.clear();
    for (const contextId of contextIds) this.clearFinishTimeout(contextId);
    this.currentContextId = "";
    this.carry = EMPTY;
    this.clearedPending = false;
    for (const contextId of contextIds) this.emitError(contextId, err);
  }

  private scheduleFinishTimeout(contextId: string, timeoutMs: number): void {
    this.clearFinishTimeout(contextId);
    const timer = setTimeout(() => {
      this.finishTimers.delete(contextId);
      if (!this.activeContexts.has(contextId)) return;
      this.activeContexts.delete(contextId);
      if (this.currentContextId === contextId) this.currentContextId = "";
      this.carry = EMPTY;
      this.emitEnd(contextId);
    }, timeoutMs);
    this.finishTimers.set(contextId, timer);
  }

  private clearFinishTimeout(contextId: string): void {
    const timer = this.finishTimers.get(contextId);
    if (!timer) return;
    clearTimeout(timer);
    this.finishTimers.delete(contextId);
  }

  private emitEnd(contextId: string): void {
    this.bus?.push(Route.Main, {
      kind: "tts.end",
      contextId,
      timestampMs: Date.now(),
    } satisfies TextToSpeechEndPacket);
  }
}

async function defaultSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@kuralle-syrinx/ws/node");
  return mod.createNodeWsSocket;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function grokProviderError(msg: Record<string, unknown>): Error {
  const message =
    (typeof msg["message"] === "string" && msg["message"]) ||
    (typeof msg["error"] === "string" && msg["error"]) ||
    "Grok TTS provider error";
  return new Error(message);
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : fallback;
}
