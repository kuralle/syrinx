// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Deepgram Aura TTS Plugin (streaming)
//
// Streaming synthesis over Deepgram's WebSocket `/v1/speak`: each sentence the
// LLM produces is sent as a `Speak` message and raw linear16 PCM streams back
// immediately, so audio starts before the full turn is generated (low latency).
// `Flush` ends a turn (acked by `Flushed`); `Clear` stops a turn on barge-in.
// One persistent socket is reused across turns (the handshake is paid once at
// init), mirroring our Cartesia plugin's connection management.
//
// Reference: LiveKit agents-js plugins/deepgram/src/tts.ts (SynthesizeStream).
// Protocol verified against the live API: Speak/Flush/Clear/Close in;
// Metadata/Flushed/Cleared/Warning/Error + binary PCM out; container=none gives
// raw linear16 (no WAV header); auth is `Authorization: Token <key>`.

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

const SPEAK = (text: string): string => JSON.stringify({ type: "Speak", text });
const FLUSH_MSG = JSON.stringify({ type: "Flush" });
const CLEAR_MSG = JSON.stringify({ type: "Clear" });
const EMPTY = new Uint8Array(0);

export class DeepgramTTSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private ws: import("ws").WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;
  private connRejecter: ((err: Error) => void) | null = null;
  private apiKey = "";
  private model = "aura-asteria-en";
  private endpointUrl = "wss://api.deepgram.com/v1/speak";
  private sampleRate = 24000;
  private retryConfig: RetryConfig = readRetryConfig({});
  private closed = false;
  private reconnecting = false;
  // Deepgram's speak socket has no per-message context id, but the engine
  // synthesizes one turn at a time, so the audio streaming back belongs to the
  // turn currently being spoken. carry holds an odd trailing PCM byte across
  // binary frames so every emitted chunk stays 16-bit sample aligned.
  private currentContextId = "";
  private carry: Uint8Array = EMPTY;
  private activeContexts = new Set<string>();
  private cancelledContexts = new Set<string>();
  private disposers: Array<() => void> = [];

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.model = optionalStringConfig(config, "model") ?? this.model;
    this.endpointUrl = optionalStringConfig(config, "endpoint_url") ?? this.endpointUrl;
    this.sampleRate = readPositiveInteger(config["sample_rate"], this.sampleRate);
    this.retryConfig = readRetryConfig(config);
    this.closed = false;

    await this.connect();

    this.disposers.push(
      bus.on("tts.text", async (pkt: unknown) => {
        const textPkt = pkt as { text: string; contextId: string };
        await this.speak(textPkt.text, textPkt.contextId);
      }),
      bus.on("tts.done", async (pkt: unknown) => {
        const donePkt = pkt as { contextId: string };
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
    const sent = await this.sendWithRetry(SPEAK(text), contextId);
    if (!sent) this.activeContexts.delete(contextId);
  }

  private async finishContext(contextId: string): Promise<void> {
    if (this.cancelledContexts.has(contextId)) return;
    // No text was synthesized for this turn (e.g. a tool-only turn): end it now.
    if (!this.activeContexts.has(contextId)) {
      this.emitEnd(contextId);
      return;
    }
    const sent = await this.sendWithRetry(FLUSH_MSG, contextId);
    if (!sent) this.activeContexts.delete(contextId);
    // tts.end is emitted when the matching `Flushed` acknowledgement arrives.
  }

  /** Flush/cancel current synthesis (called on interrupt). */
  async flush(): Promise<void> {
    await this.cancelActiveContexts();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.activeContexts.clear();
    this.cancelledContexts.clear();
    this.connResolver = null;
    this.connRejecter = null;
    this.ready = false;
    this.currentContextId = "";
    this.carry = EMPTY;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.bus = null;
  }

  private async cancelActiveContexts(): Promise<void> {
    const contextIds = [...this.activeContexts];
    for (const contextId of contextIds) this.cancelledContexts.add(contextId);
    this.activeContexts.clear();
    this.currentContextId = "";
    this.carry = EMPTY;
    if (contextIds.length === 0) return;
    // Clear stops Deepgram from streaming the rest of the interrupted turn while
    // keeping the socket open for the next turn.
    await this.sendWithRetry(CLEAR_MSG, contextIds[contextIds.length - 1] ?? "");
  }

  private async connect(): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const params = new URLSearchParams({
      model: this.model,
      encoding: "linear16",
      sample_rate: String(this.sampleRate),
      container: "none",
    });
    const separator = this.endpointUrl.includes("?") ? "&" : "?";
    const url = `${this.endpointUrl}${separator}${params.toString()}`;

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    this.ready = false;

    this.ws.on("open", () => {
      this.ready = true;
      this.connResolver?.();
      this.connResolver = null;
      this.connRejecter = null;
    });

    this.ws.on("message", (data: import("ws").RawData, isBinary: boolean) => {
      this.handleProviderMessage(data, isBinary);
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
      this.connRejecter?.(deepgramCloseError(code, reason));
      this.connResolver = null;
      this.connRejecter = null;
      if (!this.closed && !this.reconnecting) {
        if (this.activeContexts.size > 0) {
          this.failActiveContexts(deepgramCloseError(code, reason));
        }
        void this.reconnect();
      }
    });
  }

  private async sendWithRetry(payload: string, contextId: string): Promise<boolean> {
    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
      try {
        await this.ensureReady();
        const ws = this.ws;
        if (!ws || ws.readyState !== ws.OPEN) {
          throw new Error("Deepgram TTS WebSocket is not open");
        }
        ws.send(payload);
        return true;
      } catch (err) {
        const category = categorizeTtsError(err);
        if (!isRecoverable(category) || attempt >= this.retryConfig.maxAttempts) {
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
        reject(new Error("Deepgram TTS WebSocket connect timeout"));
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

  private handleProviderMessage(data: import("ws").RawData, isBinary: boolean): void {
    if (isBinary) {
      this.handleAudio(data);
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return; // non-JSON, non-binary control frame — ignore
    }

    switch (msg["type"]) {
      case "Flushed": {
        const contextId = this.currentContextId;
        this.carry = EMPTY;
        if (contextId && this.activeContexts.has(contextId)) {
          this.activeContexts.delete(contextId);
          this.emitEnd(contextId);
        }
        this.currentContextId = "";
        return;
      }
      case "Cleared":
        this.carry = EMPTY;
        return;
      case "Warning":
        return;
      case "Error":
      case "error":
        this.emitError(this.currentContextId, deepgramProviderError(msg));
        return;
      default:
        return; // Metadata and unknown control frames
    }
  }

  private handleAudio(data: import("ws").RawData): void {
    const contextId = this.currentContextId;
    if (!contextId || this.cancelledContexts.has(contextId)) return;
    const frame = toUint8(data);
    if (frame.byteLength === 0) return;

    const buf = this.carry.byteLength === 0 ? frame : concatBytes(this.carry, frame);
    const evenLen = buf.byteLength - (buf.byteLength % 2);
    if (evenLen > 0) {
      const packet: TextToSpeechAudioPacket = {
        kind: "tts.audio",
        contextId,
        timestampMs: Date.now(),
        audio: buf.subarray(0, evenLen),
        sampleRateHz: this.sampleRate,
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
    this.currentContextId = "";
    this.carry = EMPTY;
    if (contextIds.length === 0) {
      this.emitError("", err);
      return;
    }
    for (const contextId of contextIds) this.emitError(contextId, err);
  }

  private emitEnd(contextId: string): void {
    this.bus?.push(Route.Main, {
      kind: "tts.end",
      contextId,
      timestampMs: Date.now(),
    } satisfies TextToSpeechEndPacket);
  }
}

function toUint8(data: import("ws").RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function deepgramProviderError(msg: Record<string, unknown>): Error {
  const description =
    (typeof msg["description"] === "string" && msg["description"]) ||
    (typeof msg["message"] === "string" && msg["message"]) ||
    (typeof msg["err_msg"] === "string" && msg["err_msg"]) ||
    "Deepgram TTS provider error";
  return new Error(description);
}

function deepgramCloseError(code: number, reason: Buffer): Error {
  const reasonText = reason.toString("utf8").trim();
  return new Error(
    reasonText
      ? `Deepgram TTS WebSocket closed unexpectedly: code=${code} reason=${reasonText}`
      : `Deepgram TTS WebSocket closed unexpectedly: code=${code}`,
  );
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}
