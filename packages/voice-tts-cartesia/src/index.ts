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
  waitForRetryDelay,
} from "@asyncdot/voice";

export class CartesiaTTSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private ws: import("ws").WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;
  private connRejecter: ((err: Error) => void) | null = null;
  private apiKey = "";
  private voiceId = "c2ac25f9-ecc4-4f56-9095-651354df60c0";
  private modelId = "sonic-2-2025-03-07";
  private endpointUrl = "wss://api.cartesia.ai/tts/websocket";
  private apiVersion = "2024-06-10";
  private sampleRate = 16000;
  private language = "en";
  private retryConfig: RetryConfig = readRetryConfig({});
  private closed = false;
  private reconnecting = false;
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
    this.closed = false;

    await this.connect();

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
    const sent = await this.sendWithRetry(
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
    const sent = await this.sendWithRetry(
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
    this.closed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.activeContexts.clear();
    this.cancelledContexts.clear();
    this.connResolver = null;
    this.connRejecter = null;
    this.ready = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.bus = null;
  }

  private async connect(): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const params = new URLSearchParams({
      cartesia_version: this.apiVersion,
    });
    const separator = this.endpointUrl.includes("?") ? "&" : "?";
    const url = `${this.endpointUrl}${separator}${params.toString()}`;

    this.ws = new WebSocket(url, {
      headers: {
        "X-API-Key": this.apiKey,
      },
    });
    this.ready = false;

    this.ws.on("open", () => {
      this.ready = true;
      this.connResolver?.();
      this.connResolver = null;
      this.connRejecter = null;
    });

    this.ws.on("message", (data: import("ws").RawData) => {
      this.handleProviderMessage(data);
    });

    this.ws.on("error", (err: Error) => {
      this.ready = false;
      this.connRejecter?.(err);
      this.connResolver = null;
      this.connRejecter = null;
      this.failActiveContexts(err);
    });

    this.ws.on("close", (code, reason) => {
      this.ready = false;
      this.connRejecter?.(cartesiaCloseError(code, reason));
      this.connResolver = null;
      this.connRejecter = null;
      if (!this.closed && !this.reconnecting) {
        if (this.activeContexts.size > 0) {
          this.failActiveContexts(cartesiaCloseError(code, reason));
        }
        void this.reconnect();
      }
    });
  }

  private async sendWithRetry(payload: string, contextId: string): Promise<boolean> {
    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
      try {
        await this.ensureReady();
        if (!this.ws || this.ws.readyState !== (this.ws as import("ws").WebSocket).OPEN) {
          throw new Error("Cartesia TTS WebSocket is not open");
        }
        this.ws.send(payload);
        return true;
      } catch (err) {
        const category = categorizeTtsError(err);
        const recoverable = isRecoverable(category);
        if (!recoverable || attempt >= this.retryConfig.maxAttempts) {
          this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
          return false;
        }

        this.bus?.push(Route.Background, {
          kind: "metric.conversation",
          contextId,
          timestampMs: Date.now(),
          name: "tts.retry",
          value: String(attempt + 1),
        });
        await this.reconnect();
        await waitForRetryDelay(attempt, this.retryConfig);
      }
    }
    return false;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Cartesia TTS WebSocket connect timeout"));
      }, 10_000);
      this.connResolver = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.connRejecter = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    });
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.ws?.close();
    } catch {
      // best effort
    }
    try {
      await this.connect();
    } finally {
      this.reconnecting = false;
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
    await this.sendWithRetry(
      JSON.stringify({
        context_id: contextId,
        cancel: true,
      }),
      contextId,
    );
  }

  private handleProviderMessage(data: import("ws").RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
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

    if (typeof msg["data"] === "string") {
      try {
        const audioBytes = Buffer.from(msg["data"], "base64");
        const packet: TextToSpeechAudioPacket = {
          kind: "tts.audio",
          contextId,
          timestampMs: Date.now(),
          audio: new Uint8Array(audioBytes),
        };
        this.bus?.push(Route.Main, packet);
      } catch (err) {
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

function cartesiaCloseError(code: number, reason: Buffer): Error {
  const reasonText = reason.toString("utf8").trim();
  return new Error(
    reasonText
      ? `Cartesia TTS WebSocket closed unexpectedly: code=${code} reason=${reasonText}`
      : `Cartesia TTS WebSocket closed unexpectedly: code=${code}`,
  );
}
