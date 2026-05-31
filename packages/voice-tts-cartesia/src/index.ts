// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Cartesia TTS Plugin

import { randomUUID } from "node:crypto";

import type { PipelineBus } from "@asyncdot/voice";
import {
  Route,
  type PluginConfig,
  type RetryConfig,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
  type VoicePlugin,
  categorizeTtsError,
  isRecoverable,
  optionalStringConfig,
  readRetryConfig,
  requireStringConfig,
} from "@asyncdot/voice";
import { WebSocketConnection, type SocketData, type SocketFactory } from "@asyncdot/voice-ws";
import { createNodeWsSocket } from "@asyncdot/voice-ws/node";

const KEEP_ALIVE_INTERVAL_MS = 10_000;

export class CartesiaTTSPlugin implements VoicePlugin {
  // socketFactory is injectable so the same plugin runs on Node (default) or
  // Cloudflare Workers (pass createWorkersSocket).
  constructor(private readonly socketFactory: SocketFactory = createNodeWsSocket) {}

  private bus: PipelineBus | null = null;
  private conn: WebSocketConnection | null = null;
  private apiKey = "";
  private voiceId = "c2ac25f9-ecc4-4f56-9095-651354df60c0";
  private modelId = "sonic-2-2025-03-07";
  private endpointUrl = "wss://api.cartesia.ai/tts/websocket";
  private apiVersion = "2024-06-10";
  private sampleRate = 16000;
  private language = "en";
  private retryConfig: RetryConfig = readRetryConfig({});
  private activeContexts = new Set<string>();
  private cancelledContexts = new Set<string>();
  private disposers: Array<() => void> = [];

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.voiceId = optionalStringConfig(config, "voice_id") ?? this.voiceId;
    this.modelId = optionalStringConfig(config, "model_id") ?? this.modelId;
    this.endpointUrl = optionalStringConfig(config, "endpoint_url") ?? this.endpointUrl;
    this.apiVersion = optionalStringConfig(config, "cartesia_version") ?? this.apiVersion;
    this.sampleRate = (config["sample_rate"] as number) ?? this.sampleRate;
    this.language = optionalStringConfig(config, "language") ?? this.language;
    this.retryConfig = readRetryConfig(config);

    this.conn = new WebSocketConnection({
      url: () => {
        const params = new URLSearchParams({ cartesia_version: this.apiVersion });
        const separator = this.endpointUrl.includes("?") ? "&" : "?";
        return `${this.endpointUrl}${separator}${params.toString()}`;
      },
      headers: { "X-API-Key": this.apiKey },
      socketFactory: this.socketFactory,
      retry: this.retryConfig,
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
        context_id: contextId || randomUUID(),
        continue: true,
        add_timestamps: false,
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
        add_timestamps: false,
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
      this.emitError(contextId, cartesiaProviderError(msg));
      if (msg["done"] === true) this.emitEnd(contextId);
      return;
    }

    // Cartesia audio arrives as non-empty base64 `data`. Control frames such as
    // `flush_done` (the acknowledgement of a `flush: true` request) carry an empty
    // `data` string and must not be decoded as audio.
    if (typeof msg["data"] === "string" && msg["data"].length > 0) {
      try {
        const audioBytes = decodeStrictBase64(msg["data"], "Cartesia TTS provider audio data");
        const packet: TextToSpeechAudioPacket = {
          kind: "tts.audio",
          contextId,
          timestampMs: Date.now(),
          audio: new Uint8Array(audioBytes),
          sampleRateHz: this.sampleRate,
        };
        this.bus?.push(Route.Main, packet);
      } catch (err) {
        this.activeContexts.delete(contextId);
        this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (msg["done"] === true) {
      this.activeContexts.delete(contextId);
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
}

function isErrorStatusCode(value: unknown): boolean {
  return typeof value === "number" && value >= 400;
}

function cartesiaProviderError(msg: Record<string, unknown>): Error {
  const title = typeof msg["title"] === "string" ? msg["title"] : "Cartesia TTS provider error";
  const message = typeof msg["message"] === "string" ? msg["message"] : "";
  const errorCode = typeof msg["error_code"] === "string" ? msg["error_code"] : "";
  const statusCode = typeof msg["status_code"] === "number" ? `status ${String(msg["status_code"])}` : "";
  const details = [message, errorCode, statusCode].filter((part) => part.length > 0).join(" ");
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
