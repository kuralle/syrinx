// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Cartesia TTS Plugin

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  Route,
  type AudioFormat,
  type PluginConfig,
  type RetryConfig,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TextToSpeechWordTimestampsPacket,
  type TtsWordTimestamp,
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

const KEEP_ALIVE_INTERVAL_MS = 10_000;

export class CartesiaTTSPlugin implements VoicePlugin {
  // socketFactory is injectable so the same plugin runs on Node (default) or
  // Cloudflare Workers (pass createWorkersSocket).
  constructor(private readonly socketFactory?: SocketFactory) {}

  private bus: PipelineBus | null = null;
  private conn: WebSocketConnection | null = null;
  private apiKey = "";
  private voiceId = "c2ac25f9-ecc4-4f56-9095-651354df60c0";
  private modelId = "sonic-3";
  private endpointUrl = "wss://api.cartesia.ai/tts/websocket";
  private apiVersion = "2024-06-10";
  private sampleRate = 16000;
  private language = "en";
  private retryConfig: RetryConfig = readProviderRetryConfig({});
  private activeContexts = new Set<string>();
  private cancelledContexts = new Set<string>();
  private finishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposers: Array<() => void> = [];
  private audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.voiceId = optionalStringConfig(config, "voice_id") ?? this.voiceId;
    this.modelId = optionalStringConfig(config, "model_id") ?? this.modelId;
    this.endpointUrl = optionalStringConfig(config, "endpoint_url") ?? this.endpointUrl;
    this.apiVersion = optionalStringConfig(config, "cartesia_version") ?? this.apiVersion;
    this.sampleRate = (config["sample_rate"] as number) ?? this.sampleRate;
    this.language = optionalStringConfig(config, "language") ?? this.language;
    this.retryConfig = readProviderRetryConfig(config);
    const finishTimeoutMs = readNonNegativeInteger(config["finish_timeout_ms"], 2000);
    this.audioFormat = { encoding: "pcm_s16le", sampleRateHz: this.sampleRate, channels: 1 };
    assertAudioFormat(this.audioFormat);

    this.conn = new WebSocketConnection({
      url: () => {
        const params = new URLSearchParams({ cartesia_version: this.apiVersion });
        const separator = this.endpointUrl.includes("?") ? "&" : "?";
        return `${this.endpointUrl}${separator}${params.toString()}`;
      },
      headers: { "X-API-Key": this.apiKey },
      socketFactory: this.socketFactory ?? await defaultSocketFactory(),
      retry: this.retryConfig,
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 32,
      onReplay: (event, count) => {
        this.emitMetric("", `tts.cartesia.reconnect_replay_${event}`, String(count));
      },
      keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
      onMessage: (data) => this.handleProviderMessage(data),
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
        if (!this.activeContexts.has(donePkt.contextId)) {
          this.emitEnd(donePkt.contextId);
          return;
        }
        if (finishTimeoutMs > 0) this.scheduleFinishTimeout(donePkt.contextId, finishTimeoutMs);
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
    this.activeContexts.add(contextId);
    const sent = await this.trySend(
      JSON.stringify({
        model_id: this.modelId,
        transcript: text,
        voice: { mode: "id", id: this.voiceId },
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: this.sampleRate,
        },
        language: this.language,
        context_id: contextId || crypto.randomUUID(),
        continue: true,
        add_timestamps: true,
      }),
      contextId,
    );
    if (!sent) {
      this.activeContexts.delete(contextId);
    }
  }

  /** Flush/cancel current TTS generation (called on interrupt). */
  async flush(contextId = ""): Promise<void> {
    if (!contextId) {
      await this.cancelActiveContexts();
      return;
    }
    await this.cancelContext(contextId);
  }

  async finishContext(contextId: string): Promise<void> {
    if (this.cancelledContexts.has(contextId)) return;
    const sent = await this.trySend(
      JSON.stringify({
        model_id: this.modelId,
        transcript: "",
        voice: { mode: "id", id: this.voiceId },
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: this.sampleRate,
        },
        language: this.language,
        context_id: contextId,
        continue: false,
        flush: true,
      }),
      contextId,
    );
    if (!sent) {
      this.activeContexts.delete(contextId);
    }
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.activeContexts.clear();
    this.cancelledContexts.clear();
    for (const timer of this.finishTimers.values()) clearTimeout(timer);
    this.finishTimers.clear();
    await this.conn?.close();
    this.conn = null;
    this.bus = null;
  }

  /** Send a frame, ensuring the socket is ready; emit a typed error if it cannot be sent. */
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
    const contextIds = [...this.activeContexts];
    for (const contextId of contextIds) this.cancelledContexts.add(contextId);
    this.activeContexts.clear();
    await Promise.all(contextIds.map((contextId) => this.cancelContext(contextId)));
  }

  private async cancelContext(contextId: string): Promise<void> {
    if (!contextId) return;
    this.cancelledContexts.add(contextId);
    this.activeContexts.delete(contextId);
    this.clearFinishTimeout(contextId);
    await this.trySend(
      JSON.stringify({
        context_id: contextId,
        cancel: true,
      }),
      contextId,
    );
  }

  private handleProviderMessage(data: SocketData): void {
    if (typeof data !== "string") return; // Cartesia frames are JSON text
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      this.failActiveContexts(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const contextId = typeof msg["context_id"] === "string" ? msg["context_id"] : "";
    if (this.cancelledContexts.has(contextId)) {
      if (msg["done"] === true || msg["type"] === "error" || isErrorStatusCode(msg["status_code"])) {
        this.cancelledContexts.delete(contextId);
      }
      return;
    }

    if (msg["type"] === "error" || isErrorStatusCode(msg["status_code"])) {
      this.activeContexts.delete(contextId);
      this.clearFinishTimeout(contextId);
      this.emitError(contextId, cartesiaProviderError(msg));
      if (msg["done"] === true) this.emitEnd(contextId);
      return;
    }

    if (msg["type"] === "timestamps") {
      this.emitWordTimestamps(contextId, msg["word_timestamps"]);
    }

    // Cartesia audio arrives as non-empty base64 `data`. Control frames such as
    // `flush_done` (the acknowledgement of a `flush: true` request) carry an empty
    // `data` string and must not be decoded as audio.
    if (typeof msg["data"] === "string" && msg["data"].length > 0) {
      try {
        const audioBytes = decodeStrictBase64(msg["data"], "Cartesia TTS provider audio data");
        assertAudioPayload(this.audioFormat, new Uint8Array(audioBytes));
        const audioPacket: TextToSpeechAudioPacket = {
          kind: "tts.audio",
          contextId,
          timestampMs: Date.now(),
          audio: new Uint8Array(audioBytes),
          sampleRateHz: this.sampleRate,
          provider: { name: "cartesia", model: this.modelId, region: "global", cancelled: false },
        };
        this.bus?.push(Route.Main, audioPacket);
      } catch (err) {
        this.activeContexts.delete(contextId);
        this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (msg["done"] === true) {
      this.activeContexts.delete(contextId);
      this.clearFinishTimeout(contextId);
      this.emitEnd(contextId);
    }
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeTtsError(err);
    const packet: TtsErrorPacket = {
      kind: "tts.error",
      contextId,
      timestampMs: Date.now(),
      component: "tts" as const,
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
      if (!this.activeContexts.has(contextId)) return;
      this.emitMetric(contextId, "tts.cartesia.finish_timeout", String(timeoutMs));
      this.activeContexts.delete(contextId);
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
    const contextIds = [...this.activeContexts];
    this.activeContexts.clear();
    if (contextIds.length === 0) {
      this.emitError("", err);
      return;
    }
    for (const contextId of contextIds) {
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

  private emitWordTimestamps(contextId: string, value: unknown): void {
    if (!contextId || value === null || typeof value !== "object") return;
    const raw = value as Record<string, unknown>;
    const rawWords = Array.isArray(raw["words"]) ? raw["words"] : [];
    const rawStarts = Array.isArray(raw["start"]) ? raw["start"] : [];
    const rawEnds = Array.isArray(raw["end"]) ? raw["end"] : [];
    const count = Math.min(rawWords.length, rawStarts.length, rawEnds.length);
    const words: TtsWordTimestamp[] = [];
    for (let i = 0; i < count; i += 1) {
      const word = rawWords[i];
      const start = rawStarts[i];
      const end = rawEnds[i];
      if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number") continue;
      words.push({
        word,
        startMs: Math.round(start * 1000),
        endMs: Math.round(end * 1000),
      });
    }
    if (words.length === 0) return;
    this.bus?.push(Route.Main, {
      kind: "tts.word_timestamps",
      contextId,
      timestampMs: Date.now(),
      words,
    });
  }
}

async function defaultSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@kuralle-syrinx/ws/node");
  return mod.createNodeWsSocket;
}

function isErrorStatusCode(value: unknown): boolean {
  return typeof value === "number" && value >= 400;
}

function cartesiaProviderError(msg: Record<string, unknown>): Error {
  const title = typeof msg["title"] === "string" ? msg["title"] : "Cartesia TTS provider error";
  const message = typeof msg["message"] === "string" ? msg["message"] : "";
  const error = typeof msg["error"] === "string" ? msg["error"] : "";
  const errorCode = typeof msg["error_code"] === "string" ? msg["error_code"] : "";
  const statusCode = typeof msg["status_code"] === "number" ? `status ${String(msg["status_code"])}` : "";
  const details = [message, error, errorCode, statusCode].filter((part) => part.length > 0).join(" ");
  return new Error(details ? `${title}: ${details}` : title);
}

function decodeStrictBase64(value: string, name: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error(`${name} must be valid base64`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error(`${name} must be valid base64`);
  }
  return decoded;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : fallback;
}
