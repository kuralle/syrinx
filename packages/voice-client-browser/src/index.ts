// SPDX-License-Identifier: MIT

export {
  decodeBrowserAssistantAudio,
  encodeBrowserAudioEnvelopeFrame,
  encodeBrowserAudioFrame,
  float32ToPcm16,
  pcm16FrameSampleCount,
  resampleFloat32Linear,
  type EncodeBrowserAudioOptions,
  type ResampleFloat32Options,
  type SyrinxAudioJsonFrame,
} from "./audio.js";

import { encodeSyrinxAudioEnvelope } from "@asyncdot/voice";
import {
  decodeBrowserAssistantAudio,
  encodeBrowserAudioEnvelopeFrame,
  type BrowserAssistantAudio,
  type EncodeBrowserAudioOptions,
} from "./audio.js";

export type SyrinxStudioMessage =
  | {
      readonly type: "ready";
      readonly sessionId?: string;
      readonly resumed?: boolean;
      readonly resumeWindowMs?: number;
      readonly audio?: {
        readonly inputSampleRateHz: number;
        readonly outputSampleRateHz: number;
        readonly encoding: "pcm_s16le";
        readonly channels: 1;
        readonly binaryEnvelope?: "syrinx.audio.v1";
        readonly rawBinaryInput?: boolean;
      };
    }
  | { readonly type: "speech_started"; readonly turnId?: string }
  | { readonly type: "speech_ended"; readonly turnId?: string }
  | { readonly type: "stt_chunk"; readonly turnId?: string; readonly transcript: string }
  | { readonly type: "stt_output"; readonly turnId?: string; readonly transcript: string; readonly confidence?: number }
  | { readonly type: "agent_chunk"; readonly turnId?: string; readonly text: string }
  | { readonly type: "agent_tool_call"; readonly turnId?: string; readonly id?: string; readonly name: string; readonly args?: unknown }
  | { readonly type: "agent_tool_result"; readonly turnId?: string; readonly id?: string; readonly result?: unknown }
  | { readonly type: "agent_end"; readonly turnId?: string }
  | { readonly type: "agent_interrupted"; readonly turnId?: string; readonly reason?: string }
  | { readonly type: "audio_clear"; readonly turnId?: string; readonly reason?: string }
  | { readonly type: "tts_end"; readonly turnId?: string }
  | {
      readonly type: "tts_chunk";
      readonly turnId?: string;
      readonly sequence: number;
      readonly sampleRateHz: number;
      readonly encoding: "pcm_s16le";
      readonly channels: 1;
      readonly byteLength: number;
      readonly durationMs: number;
    }
  | {
      readonly type: "metrics";
      readonly sttMs?: number;
      readonly llmTTFTMs?: number;
      readonly ttsTTFBMs?: number;
      readonly e2eMs?: number;
    }
  | { readonly type: "error"; readonly component?: string; readonly category?: string; readonly message: string };

type SyrinxReadyAudio = Extract<SyrinxStudioMessage, { readonly type: "ready" }>["audio"];

export type SyrinxBrowserClientEvent =
  | { readonly type: "open" }
  | { readonly type: "close"; readonly code: number; readonly reason: string }
  | { readonly type: "error"; readonly error: Event | Error }
  | { readonly type: "message"; readonly message: SyrinxStudioMessage }
  | { readonly type: "audio"; readonly data: ArrayBuffer; readonly metadata?: BrowserAssistantAudio["metadata"] }
  | { readonly type: "reconnecting"; readonly attempt: number; readonly delayMs: number }
  | { readonly type: "reconnected"; readonly attempt: number }
  | { readonly type: "resumed" };

export type SyrinxBrowserClientHandler = (event: SyrinxBrowserClientEvent) => void;

export interface SyrinxBrowserClientOptions {
  readonly url: string;
  readonly protocols?: string | readonly string[];
  /**
   * Auto-reconnect on unexpected close. Set false to disable entirely.
   * Defaults to enabled with 10 attempts, 1 s base delay, 30 s cap.
   */
  readonly reconnect?: false | {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    /** A reconnect that opens then dies within this window counts as a quick failure. Default 5000 ms. */
    readonly minStableMs?: number;
    /** Consecutive quick failures (open-then-die) before giving up — backoff can't fix a flapping peer. Default 3. */
    readonly maxQuickFailures?: number;
  };
  /**
   * Interval (ms) for periodic {type:"ping"} keepalives. Set false to disable.
   * Default: 10 000 ms — below typical proxy idle-kill thresholds.
   */
  readonly keepaliveIntervalMs?: number | false;
}

const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_MIN_STABLE_MS = 5_000;
const RECONNECT_MAX_QUICK_FAILURES = 3;
const KEEPALIVE_INTERVAL_MS = 10_000;

export class SyrinxBrowserClient {
  private socket: WebSocket | null = null;
  private readonly handlers = new Set<SyrinxBrowserClientHandler>();
  private audioSequence = 0;
  private currentSessionId: string | null = null;
  private cleanClose = false;
  private reconnectAttempt = 0;
  private quickFailures = 0;
  private openedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: SyrinxBrowserClientOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** The sessionId received from the server's last `ready` message. Used to resume on reconnect. */
  get sessionId(): string | null {
    return this.currentSessionId;
  }

  on(handler: SyrinxBrowserClientHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  connect(): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      return;
    }
    this.cleanClose = false;
    this.cancelReconnect();
    this.openSocket();
  }

  close(code?: number, reason?: string): void {
    this.cleanClose = true;
    this.cancelReconnect();
    this.stopKeepalive();
    this.socket?.close(code, reason);
  }

  sendAudioPcm(
    audio: ArrayBuffer | ArrayBufferView,
    sampleRateHz: number,
    options: { readonly contextId?: string; readonly sequence?: number } = {},
  ): void {
    const bytes = ArrayBuffer.isView(audio)
      ? new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
      : new Uint8Array(audio);
    if (bytes.byteLength % 2 !== 0) throw new Error("PCM16 audio payload must contain an even number of bytes");
    const sampleRate = readPositiveSampleRate(sampleRateHz);
    this.requireOpenSocket().send(encodeBrowserPcmEnvelope(bytes, sampleRate, {
      ...options,
      sequence: this.nextAudioSequence(options.sequence),
    }) as Uint8Array<ArrayBuffer>);
  }

  sendAudioBase64(
    audio: string,
    sampleRateHz: number,
    options: { readonly contextId?: string; readonly sequence?: number } = {},
  ): void {
    this.sendJson({
      type: "audio",
      audio,
      sampleRateHz,
      contextId: options.contextId,
      sequence: this.nextAudioSequence(options.sequence),
    });
  }

  sendFloat32Audio(input: Float32Array, options: EncodeBrowserAudioOptions): void {
    const sequence = this.nextAudioSequence(options.sequence);
    this.requireOpenSocket().send(encodeBrowserAudioEnvelopeFrame(input, { ...options, sequence }) as Uint8Array<ArrayBuffer>);
  }

  sendText(text: string): void {
    this.sendJson({ type: "text", text });
  }

  sendJson(value: unknown): void {
    this.requireOpenSocket().send(JSON.stringify(value));
  }

  private openSocket(): void {
    const url = this.currentSessionId !== null
      ? buildResumeUrl(this.options.url, this.currentSessionId)
      : this.options.url;
    const socket = new WebSocket(url, this.options.protocols as string | string[] | undefined);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.openedAt = Date.now();
      if (this.reconnectAttempt > 0) {
        const attempt = this.reconnectAttempt;
        this.reconnectAttempt = 0;
        this.emit({ type: "reconnected", attempt });
      } else {
        this.emit({ type: "open" });
      }
      this.startKeepalive(socket);
    });

    socket.addEventListener("close", (event) => {
      this.stopKeepalive();
      if (this.cleanClose) {
        this.emit({ type: "close", code: event.code, reason: event.reason });
        return;
      }
      this.scheduleReconnect(event.code, event.reason);
    });

    socket.addEventListener("error", (event) => {
      this.emit({ type: "error", error: event });
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
  }

  private scheduleReconnect(code: number, reason: string): void {
    const opts = this.options.reconnect;
    if (opts === false) {
      this.emit({ type: "close", code, reason });
      return;
    }

    const maxAttempts = opts?.maxAttempts ?? RECONNECT_MAX_ATTEMPTS;
    const baseDelayMs = opts?.baseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    const maxDelayMs = opts?.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    const minStableMs = opts?.minStableMs ?? RECONNECT_MIN_STABLE_MS;
    const maxQuickFailures = opts?.maxQuickFailures ?? RECONNECT_MAX_QUICK_FAILURES;

    // Quick-failure guard: a socket that opens then dies within minStableMs,
    // repeatedly, won't be fixed by backoff (a flapping/half-broken peer mid-deploy,
    // a bad token accepted-then-rejected). Distinct from a never-opening peer, which
    // the maxAttempts cap handles. A genuinely stable connection resets the count.
    const opened = this.openedAt > 0;
    const stable = opened && Date.now() - this.openedAt >= minStableMs;
    this.openedAt = 0;
    if (stable) {
      this.quickFailures = 0;
    } else if (opened) {
      this.quickFailures += 1;
      if (this.quickFailures >= maxQuickFailures) {
        this.quickFailures = 0;
        this.emit({ type: "close", code, reason });
        return;
      }
    }

    this.reconnectAttempt += 1;

    if (maxAttempts > 0 && this.reconnectAttempt > maxAttempts) {
      this.emit({ type: "close", code, reason });
      return;
    }

    const exponential = Math.min(baseDelayMs * Math.pow(2, this.reconnectAttempt - 1), maxDelayMs);
    const jitter = exponential * 0.2 * Math.random();
    const delayMs = Math.round(exponential + jitter);

    this.emit({ type: "reconnecting", attempt: this.reconnectAttempt, delayMs });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.cleanClose) return;
      this.openSocket();
    }, delayMs);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.quickFailures = 0;
    this.openedAt = 0;
  }

  private startKeepalive(socket: WebSocket): void {
    this.stopKeepalive();
    const intervalMs = this.options.keepaliveIntervalMs;
    if (intervalMs === false) return;
    const ms = typeof intervalMs === "number" && intervalMs > 0 ? intervalMs : KEEPALIVE_INTERVAL_MS;
    this.keepaliveTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      } else {
        this.stopKeepalive();
      }
    }, ms);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      try {
        const message = parseStudioMessage(JSON.parse(data) as unknown);
        if (message.type === "ready" && message.sessionId !== undefined) {
          this.currentSessionId = message.sessionId;
        }
        this.emit({ type: "message", message });
        if (message.type === "ready" && message.resumed === true) {
          this.emit({ type: "resumed" });
        }
      } catch (err) {
        this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
      }
      return;
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => {
        const audio = decodeBrowserAssistantAudio(buffer);
        this.emit({ type: "audio", data: audio.data, metadata: audio.metadata });
      }).catch((err: unknown) => {
        this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
      });
      return;
    }
    if (data instanceof ArrayBuffer) {
      try {
        const audio = decodeBrowserAssistantAudio(data);
        this.emit({ type: "audio", data: audio.data, metadata: audio.metadata });
      } catch (err) {
        this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
  }

  private requireOpenSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("SyrinxBrowserClient WebSocket is not open");
    }
    return this.socket;
  }

  private nextAudioSequence(sequence: number | undefined): number {
    if (sequence !== undefined) {
      if (!Number.isInteger(sequence) || sequence < 0) throw new Error("audio sequence must be a non-negative integer");
      if (sequence <= this.audioSequence) {
        throw new Error(`audio sequence must increase monotonically: ${String(this.audioSequence)} -> ${String(sequence)}`);
      }
      this.audioSequence = Math.max(this.audioSequence, sequence);
      return sequence;
    }
    this.audioSequence += 1;
    return this.audioSequence;
  }

  private emit(event: SyrinxBrowserClientEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

function buildResumeUrl(baseUrl: string, sessionId: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("sessionId", sessionId);
    return url.toString();
  } catch {
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}sessionId=${encodeURIComponent(sessionId)}`;
  }
}

function encodeBrowserPcmEnvelope(
  audio: Uint8Array,
  sampleRateHz: number,
  options: { readonly contextId?: string; readonly sequence?: number },
): Uint8Array {
  return encodeSyrinxAudioEnvelope({
    type: "audio",
    contextId: options.contextId,
    sampleRateHz,
    sequence: options.sequence,
    encoding: "pcm_s16le",
    channels: 1,
    byteLength: audio.byteLength,
    durationMs: Math.round((audio.byteLength / 2 / sampleRateHz) * 1000),
  }, audio);
}

function readPositiveSampleRate(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error("sampleRateHz must be a positive integer");
  return value;
}

function parseStudioMessage(value: unknown): SyrinxStudioMessage {
  if (!isRecord(value)) throw new Error("Syrinx websocket message must be an object");
  const type = requiredString(value.type, "Syrinx websocket message type");
  if (type === "ready") {
    return {
      type,
      sessionId: optionalString(value.sessionId, "ready.sessionId"),
      resumed: optionalBoolean(value.resumed, "ready.resumed"),
      resumeWindowMs: optionalNumber(value.resumeWindowMs, "ready.resumeWindowMs"),
      audio: parseReadyAudio(value.audio),
    };
  }
  if (type === "speech_started" || type === "speech_ended" || type === "agent_end" || type === "tts_end") {
    return { type, turnId: optionalString(value.turnId, `${type}.turnId`) };
  }
  if (type === "stt_chunk" || type === "stt_output") {
    return {
      type,
      turnId: optionalString(value.turnId, `${type}.turnId`),
      transcript: requiredString(value.transcript, `${type}.transcript`),
      ...(type === "stt_output" ? { confidence: optionalNumber(value.confidence, "stt_output.confidence") } : {}),
    } as SyrinxStudioMessage;
  }
  if (type === "agent_chunk") {
    return {
      type,
      turnId: optionalString(value.turnId, "agent_chunk.turnId"),
      text: requiredString(value.text, "agent_chunk.text"),
    };
  }
  if (type === "agent_tool_call") {
    return {
      type,
      turnId: optionalString(value.turnId, "agent_tool_call.turnId"),
      id: optionalString(value.id, "agent_tool_call.id"),
      name: requiredString(value.name, "agent_tool_call.name"),
      args: value.args,
    };
  }
  if (type === "agent_tool_result") {
    return {
      type,
      turnId: optionalString(value.turnId, "agent_tool_result.turnId"),
      id: optionalString(value.id, "agent_tool_result.id"),
      result: value.result,
    };
  }
  if (type === "agent_interrupted" || type === "audio_clear") {
    return {
      type,
      turnId: optionalString(value.turnId, `${type}.turnId`),
      reason: optionalString(value.reason, `${type}.reason`),
    };
  }
  if (type === "tts_chunk") {
    return {
      type,
      turnId: optionalString(value.turnId, "tts_chunk.turnId"),
      sequence: requiredNonNegativeInteger(value.sequence, "tts_chunk.sequence"),
      sampleRateHz: requiredPositiveInteger(value.sampleRateHz, "tts_chunk.sampleRateHz"),
      encoding: requiredLiteral(value.encoding, "pcm_s16le", "tts_chunk.encoding"),
      channels: requiredLiteral(value.channels, 1, "tts_chunk.channels"),
      byteLength: requiredNonNegativeInteger(value.byteLength, "tts_chunk.byteLength"),
      durationMs: requiredNonNegativeInteger(value.durationMs, "tts_chunk.durationMs"),
    };
  }
  if (type === "metrics") {
    return {
      type,
      sttMs: optionalNumber(value.sttMs, "metrics.sttMs"),
      llmTTFTMs: optionalNumber(value.llmTTFTMs, "metrics.llmTTFTMs"),
      ttsTTFBMs: optionalNumber(value.ttsTTFBMs, "metrics.ttsTTFBMs"),
      e2eMs: optionalNumber(value.e2eMs, "metrics.e2eMs"),
    };
  }
  if (type === "error") {
    return {
      type,
      component: optionalString(value.component, "error.component"),
      category: optionalString(value.category, "error.category"),
      message: requiredString(value.message, "error.message"),
    };
  }
  throw new Error(`Unsupported Syrinx websocket message type: ${type}`);
}

function parseReadyAudio(value: unknown): SyrinxReadyAudio {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("ready.audio must be an object");
  return {
    inputSampleRateHz: requiredPositiveInteger(value.inputSampleRateHz, "ready.audio.inputSampleRateHz"),
    outputSampleRateHz: requiredPositiveInteger(value.outputSampleRateHz, "ready.audio.outputSampleRateHz"),
    encoding: requiredLiteral(value.encoding, "pcm_s16le", "ready.audio.encoding"),
    channels: requiredLiteral(value.channels, 1, "ready.audio.channels"),
    binaryEnvelope: value.binaryEnvelope === undefined
      ? undefined
      : requiredLiteral(value.binaryEnvelope, "syrinx.audio.v1", "ready.audio.binaryEnvelope"),
    rawBinaryInput: optionalBoolean(value.rawBinaryInput, "ready.audio.rawBinaryInput"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function requiredLiteral<T extends string | number>(value: unknown, expected: T, name: string): T {
  if (value !== expected) throw new Error(`${name} must be ${String(expected)}`);
  return expected;
}
