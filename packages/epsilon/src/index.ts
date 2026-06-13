// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Epsilon TTS Plugin (multiplexed WebSocket)

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
import { WebSocketConnection, type SocketData, type SocketFactory } from "@kuralle-syrinx/ws";

import { parseEpsilonBinaryFrame } from "./binary-frame.js";

const KEEP_ALIVE_INTERVAL_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;
const EPSILON_SAMPLE_RATE_HZ = 24_000;
const EMPTY = new Uint8Array(0);
const EPSILON_VOICES = ["sinhala", "english", "tamil"] as const;

export type EpsilonVoice = (typeof EPSILON_VOICES)[number];

export { parseEpsilonBinaryFrame, encodeEpsilonBinaryFrame } from "./binary-frame.js";
export type { ParsedEpsilonBinaryFrame } from "./binary-frame.js";

export class EpsilonTTSPlugin implements VoicePlugin {
  constructor(private readonly socketFactory?: SocketFactory) {}

  private bus: PipelineBus | null = null;
  private conn: WebSocketConnection | null = null;
  private apiKey = "";
  private baseUrl = "";
  private voice: EpsilonVoice = "sinhala";
  private sampleRate = EPSILON_SAMPLE_RATE_HZ;
  private retryConfig: RetryConfig = readProviderRetryConfig({});
  private requestToContext = new Map<string, string>();
  private contextActiveRequests = new Map<string, Set<string>>();
  private contextUtteranceSeq = new Map<string, number>();
  private contextPendingEnd = new Set<string>();
  private cancelledContexts = new Set<string>();
  private cancelledRequests = new Set<string>();
  private carryByRequest = new Map<string, Uint8Array>();
  private finishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposers: Array<() => void> = [];
  private audioFormat: AudioFormat = {
    encoding: "pcm_s16le",
    sampleRateHz: EPSILON_SAMPLE_RATE_HZ,
    channels: 1,
  };

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.baseUrl = readRequiredBaseUrl(config);
    this.voice = readEpsilonVoice(config);
    this.sampleRate = readEpsilonSampleRate(config);
    this.retryConfig = readProviderRetryConfig(config);
    const finishTimeoutMs = readNonNegativeInteger(config["finish_timeout_ms"], 2000);
    this.audioFormat = { encoding: "pcm_s16le", sampleRateHz: this.sampleRate, channels: 1 };
    assertAudioFormat(this.audioFormat);

    const connectTimeoutMs = readPositiveInteger(config["connect_timeout_ms"], DEFAULT_CONNECT_TIMEOUT_MS);
    this.conn = new WebSocketConnection({
      url: () => buildEpsilonWsUrl(this.baseUrl, this.apiKey),
      socketFactory: this.socketFactory ?? (await defaultSocketFactory()),
      retry: this.retryConfig,
      maxReconnectAttempts: 1,
      connectTimeoutMs,
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 32,
      onReplay: (event, count) => {
        this.emitMetric("", `tts.epsilon.reconnect_replay_${event}`, String(count));
      },
      keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
      onMessage: (data, isBinary) => this.handleProviderMessage(data, isBinary),
      onConnectionLost: (err) => this.failActiveContexts(err),
      onUnrecoverable: (err) => this.failActiveContexts(err),
    });
    await this.conn.connect();

    this.disposers.push(
      bus.on("tts.text", async (pkt: unknown) => {
        const textPkt = pkt as { text: string; contextId: string };
        await this.sendText(textPkt.text, textPkt.contextId);
      }),
      bus.on("tts.done", async (pkt: unknown) => {
        const donePkt = pkt as { contextId: string };
        if (finishTimeoutMs > 0 && this.hasActiveRequests(donePkt.contextId)) {
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

  async sendText(text: string, contextId: string): Promise<void> {
    if (!text.trim()) return;
    if (this.cancelledContexts.has(contextId)) return;

    const requestId = this.nextRequestId(contextId);
    this.trackRequest(requestId, contextId);
    const sent = await this.trySend(
      JSON.stringify({
        type: "speak",
        request_id: requestId,
        input: text,
        voice: this.voice,
      }),
      contextId,
    );
    if (!sent) {
      this.untrackRequest(requestId, contextId);
    }
  }

  async flush(contextId = ""): Promise<void> {
    if (!contextId) {
      await this.cancelActiveContexts();
      return;
    }
    await this.cancelContext(contextId);
  }

  async finishContext(contextId: string): Promise<void> {
    if (this.cancelledContexts.has(contextId)) return;
    if (!this.hasActiveRequests(contextId)) {
      this.emitEnd(contextId);
      return;
    }
    this.contextPendingEnd.add(contextId);
    this.tryEmitEndIfComplete(contextId);
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.contextPendingEnd.clear();
    this.cancelledContexts.clear();
    this.cancelledRequests.clear();
    this.requestToContext.clear();
    this.contextActiveRequests.clear();
    this.contextUtteranceSeq.clear();
    this.carryByRequest.clear();
    for (const timer of this.finishTimers.values()) clearTimeout(timer);
    this.finishTimers.clear();
    try {
      await this.conn?.ensureReady();
      this.conn?.send(JSON.stringify({ type: "eos" }));
    } catch {
      // Best-effort session shutdown.
    }
    await this.conn?.close();
    this.conn = null;
    this.bus = null;
  }

  private nextRequestId(contextId: string): string {
    const seq = this.contextUtteranceSeq.get(contextId) ?? 0;
    this.contextUtteranceSeq.set(contextId, seq + 1);
    return `${contextId}:${String(seq)}`;
  }

  private trackRequest(requestId: string, contextId: string): void {
    this.requestToContext.set(requestId, contextId);
    const active = this.contextActiveRequests.get(contextId) ?? new Set<string>();
    active.add(requestId);
    this.contextActiveRequests.set(contextId, active);
  }

  private untrackRequest(requestId: string, contextId: string): void {
    this.requestToContext.delete(requestId);
    this.carryByRequest.delete(requestId);
    const active = this.contextActiveRequests.get(contextId);
    if (!active) return;
    active.delete(requestId);
    if (active.size === 0) this.contextActiveRequests.delete(contextId);
  }

  private hasActiveRequests(contextId: string): boolean {
    return (this.contextActiveRequests.get(contextId)?.size ?? 0) > 0;
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

  private async cancelActiveContexts(): Promise<void> {
    const contextIds = [...this.contextActiveRequests.keys(), ...this.contextPendingEnd];
    for (const contextId of new Set(contextIds)) {
      this.cancelledContexts.add(contextId);
      this.contextPendingEnd.delete(contextId);
      this.clearFinishTimeout(contextId);
      await this.cancelContext(contextId);
    }
  }

  private async cancelContext(contextId: string): Promise<void> {
    if (!contextId) return;
    this.cancelledContexts.add(contextId);
    this.contextPendingEnd.delete(contextId);
    this.clearFinishTimeout(contextId);
    const requestIds = [...(this.contextActiveRequests.get(contextId) ?? [])];
    for (const requestId of requestIds) {
      this.cancelledRequests.add(requestId);
      await this.trySend(JSON.stringify({ type: "cancel", request_id: requestId }), contextId);
    }
  }

  private handleProviderMessage(data: SocketData, isBinary: boolean): void {
    if (isBinary && typeof data !== "string") {
      this.handleBinaryFrame(data);
      return;
    }
    if (typeof data !== "string") return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      this.failActiveContexts(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const type = typeof msg["type"] === "string" ? msg["type"] : "";
    const requestId = typeof msg["request_id"] === "string" ? msg["request_id"] : "";
    const contextId = requestId ? (this.requestToContext.get(requestId) ?? "") : "";

    switch (type) {
      case "started":
        return;
      case "done":
        this.handleDone(requestId, contextId);
        return;
      case "cancelled":
        this.handleCancelled(requestId, contextId);
        return;
      case "error":
        this.handleError(requestId, contextId, msg);
        return;
      default:
        return;
    }
  }

  private handleBinaryFrame(frame: Uint8Array): void {
    let parsed;
    try {
      parsed = parseEpsilonBinaryFrame(frame);
    } catch (err) {
      this.failActiveContexts(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const { requestId, pcm } = parsed;
    const contextId = this.requestToContext.get(requestId) ?? "";
    if (!contextId || this.cancelledContexts.has(contextId) || this.cancelledRequests.has(requestId)) {
      return;
    }
    if (pcm.byteLength === 0) return;

    const carry = this.carryByRequest.get(requestId) ?? EMPTY;
    const buf = carry.byteLength === 0 ? pcm : concatBytes(carry, pcm);
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
        provider: { name: "epsilon", model: "epsilon-tts", region: "global", cancelled: false },
      };
      this.bus?.push(Route.Main, packet);
    }
    this.carryByRequest.set(requestId, evenLen < buf.byteLength ? buf.subarray(evenLen) : EMPTY);
  }

  private handleDone(requestId: string, contextId: string): void {
    if (!requestId || !contextId) return;
    this.carryByRequest.delete(requestId);
    this.cancelledRequests.delete(requestId);
    this.untrackRequest(requestId, contextId);
    if (this.cancelledContexts.has(contextId)) return;
    this.tryEmitEndIfComplete(contextId);
  }

  private handleCancelled(requestId: string, contextId: string): void {
    if (!requestId) return;
    this.carryByRequest.delete(requestId);
    this.cancelledRequests.delete(requestId);
    if (contextId) this.untrackRequest(requestId, contextId);
  }

  private handleError(requestId: string, contextId: string, msg: Record<string, unknown>): void {
    if (requestId) {
      this.carryByRequest.delete(requestId);
      this.untrackRequest(requestId, contextId);
    }
    if (contextId && this.cancelledContexts.has(contextId)) return;
    this.emitError(contextId, epsilonProviderError(msg));
    if (contextId) this.tryEmitEndIfComplete(contextId);
  }

  private tryEmitEndIfComplete(contextId: string): void {
    if (!this.contextPendingEnd.has(contextId)) return;
    if (this.hasActiveRequests(contextId)) return;
    this.contextPendingEnd.delete(contextId);
    this.clearFinishTimeout(contextId);
    this.contextUtteranceSeq.delete(contextId);
    this.cancelledContexts.delete(contextId);
    this.emitEnd(contextId);
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

  private scheduleFinishTimeout(contextId: string, timeoutMs: number): void {
    this.clearFinishTimeout(contextId);
    const timer = setTimeout(() => {
      this.finishTimers.delete(contextId);
      if (!this.contextPendingEnd.has(contextId) && !this.hasActiveRequests(contextId)) return;
      this.emitMetric(contextId, "tts.epsilon.finish_timeout", String(timeoutMs));
      this.contextPendingEnd.delete(contextId);
      this.contextActiveRequests.delete(contextId);
      this.contextUtteranceSeq.delete(contextId);
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

  private emitMetric(contextId: string, name: string, value: string): void {
    this.bus?.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: Date.now(),
      name,
      value,
    });
  }

  private failActiveContexts(err: Error): void {
    const contextIds = new Set<string>([
      ...this.contextActiveRequests.keys(),
      ...this.contextPendingEnd,
    ]);
    this.contextPendingEnd.clear();
    this.contextActiveRequests.clear();
    this.requestToContext.clear();
    this.carryByRequest.clear();
    for (const contextId of contextIds) {
      this.clearFinishTimeout(contextId);
      this.emitError(contextId, err);
    }
  }

  private emitEnd(contextId: string): void {
    const packet: TextToSpeechEndPacket = {
      kind: "tts.end",
      contextId,
      timestampMs: Date.now(),
    };
    this.bus?.push(Route.Main, packet);
  }
}

export function buildEpsilonWsUrl(baseUrl: string, apiKey: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  const path = trimmed.endsWith("/v1/audio/speech/ws")
    ? trimmed
    : `${trimmed}/v1/audio/speech/ws`;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}key=${encodeURIComponent(apiKey)}`;
}

export function readRequiredBaseUrl(config: PluginConfig): string {
  const baseUrl = optionalStringConfig(config, "base_url") ?? optionalStringConfig(config, "baseUrl");
  if (!baseUrl) {
    throw new Error("Plugin config missing required key: base_url (Epsilon TTS baseUrl)");
  }
  return baseUrl;
}

function readEpsilonVoice(config: PluginConfig): EpsilonVoice {
  const voice = optionalStringConfig(config, "voice") ?? "sinhala";
  if (!EPSILON_VOICES.includes(voice as EpsilonVoice)) {
    throw new Error(`Epsilon TTS voice must be one of: ${EPSILON_VOICES.join(", ")}`);
  }
  return voice as EpsilonVoice;
}

function readEpsilonSampleRate(config: PluginConfig): number {
  const sampleRate = config["sample_rate"];
  if (sampleRate === undefined) return EPSILON_SAMPLE_RATE_HZ;
  if (sampleRate !== EPSILON_SAMPLE_RATE_HZ) {
    throw new Error(`Epsilon TTS only supports sample_rate ${String(EPSILON_SAMPLE_RATE_HZ)}`);
  }
  return EPSILON_SAMPLE_RATE_HZ;
}

async function defaultSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@kuralle-syrinx/ws/node");
  return mod.createNodeWsSocket;
}

function epsilonProviderError(msg: Record<string, unknown>): Error {
  const message = typeof msg["message"] === "string" ? msg["message"] : "Epsilon TTS provider error";
  return new Error(message);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}
