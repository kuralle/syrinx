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

import {
  createBrowserOpusCodec,
  encodeBrowserOpusEnvelope,
  encodeBrowserPcmEnvelope,
  loadBrowserOpusModule,
  pickBrowserWireCodec,
  type BrowserOpusCodec,
  type BrowserWireCodec,
} from "./browser-opus.js";
import { BROWSER_OPUS_SAMPLE_RATE_HZ } from "./browser-opus.js";
import { pcm16BytesToSamples, pcm16SamplesToBytes, resamplePcm16 } from "@asyncdot/voice/audio";
import {
  decodeBrowserAssistantAudio,
  encodeBrowserAudioEnvelopeFrame,
  float32ToPcm16,
  resampleFloat32Linear,
  AudioJitterBuffer,
  type BrowserAssistantAudio,
  type EncodeBrowserAudioOptions,
  type AudioJitterBufferOptions,
} from "./audio.js";
import type { ClientTransport } from "./transport.js";
import { WebSocketClientTransport } from "./websocket-transport.js";

export type { ClientTransport, ClientTransportHandlers } from "./transport.js";
export { WebSocketClientTransport } from "./websocket-transport.js";
export {
  BROWSER_OPUS_FRAME_DURATION_MS,
  BROWSER_OPUS_SAMPLE_RATE_HZ,
  BROWSER_SUPPORTED_INPUT_CODECS,
  createBrowserOpusCodec,
  encodeBrowserOpusEnvelope,
  encodeBrowserPcmEnvelope,
  loadBrowserOpusModule,
  pickBrowserWireCodec,
  type BrowserOpusCodec,
  type BrowserWireCodec,
} from "./browser-opus.js";

export type SyrinxStudioMessage =
  | {
      readonly type: "ready";
      readonly sessionId?: string;
      readonly resumed?: boolean;
      readonly resumeWindowMs?: number;
      readonly audio?: {
        readonly inputSampleRateHz: number;
        readonly outputSampleRateHz: number;
        readonly encoding: "pcm_s16le" | "opus";
        readonly supportedInputCodecs?: readonly string[];
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
  /** Injectable transport seam (default: WebSocket). Future: WebRTC / WebTransport. */
  readonly transport?: ClientTransport;
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
  /**
   * AudioContext for audio playback scheduling. If provided, enables jitter buffering.
   * If not provided, audio events are emitted directly without buffering.
   */
  readonly audioContext?: AudioContext;
  /**
   * Jitter buffer configuration. Only used when audioContext is provided.
   */
  readonly jitterBuffer?: Omit<AudioJitterBufferOptions, "sampleRateHz">;
}

const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_MIN_STABLE_MS = 5_000;
const RECONNECT_MAX_QUICK_FAILURES = 3;
const KEEPALIVE_INTERVAL_MS = 10_000;

export class SyrinxBrowserClient {
  private readonly transport: ClientTransport;
  private readonly handlers = new Set<SyrinxBrowserClientHandler>();
  private audioSequence = 0;
  private currentSessionId: string | null = null;
  private cleanClose = false;
  private reconnectAttempt = 0;
  private quickFailures = 0;
  private openedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private jitterBuffer: AudioJitterBuffer | null = null;
  private outputSampleRateHz = 16000;
  private wireCodec: BrowserWireCodec = "pcm_s16le";
  private inputSampleRateHz = 16000;
  private opusCodec: BrowserOpusCodec | null = null;
  private opusLoadFailed = false;
  private codecNegotiation: Promise<void> | null = null;
  private pendingUplink: Array<() => void> = [];

  constructor(private readonly options: SyrinxBrowserClientOptions) {
    this.transport = options.transport ?? new WebSocketClientTransport({ protocols: options.protocols });
    this.transport.setHandlers({
      onOpen: () => this.handleTransportOpen(),
      onClose: (code, reason) => this.handleTransportClose(code, reason),
      onError: (error) => this.emit({ type: "error", error }),
      onMessage: (data) => this.handleTransportMessage(data),
      onAudio: (data) => this.handleTransportAudio(data),
    });
    if (options.audioContext) {
      this.jitterBuffer = new AudioJitterBuffer(options.audioContext, {
        sampleRateHz: this.outputSampleRateHz,
        ...options.jitterBuffer,
      });
    }
  }

  get connected(): boolean {
    return this.transport.connected;
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
    if (this.transport.connected) return;
    this.cleanClose = false;
    this.cancelReconnect();
    void loadBrowserOpusModule().catch(() => undefined);
    this.openTransport();
  }

  close(code?: number, reason?: string): void {
    this.cleanClose = true;
    this.cancelReconnect();
    this.stopKeepalive();
    this.jitterBuffer?.clear();
    this.transport.disconnect(code, reason);
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
    this.scheduleUplink(() => {
      for (const frame of this.encodeUplinkPcm(bytes, sampleRate, options)) {
        this.requireOpenTransport().sendAudio(frame);
      }
    });
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
    if (this.wireCodec === "opus" && this.opusCodec) {
      const targetRate = readPositiveSampleRate(options.toSampleRateHz);
      const resampled = resampleFloat32Linear(input, options);
      const pcm = float32ToPcm16(resampled);
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      this.scheduleUplink(() => {
        for (const frame of this.encodeUplinkPcm(bytes, targetRate, options)) {
          this.requireOpenTransport().sendAudio(frame);
        }
      });
      return;
    }
    const sequence = this.nextAudioSequence(options.sequence);
    this.scheduleUplink(() => {
      this.requireOpenTransport().sendAudio(
        encodeBrowserAudioEnvelopeFrame(input, { ...options, sequence }) as Uint8Array<ArrayBuffer>,
      );
    });
  }

  sendText(text: string): void {
    this.sendJson({ type: "text", text });
  }

  sendJson(value: unknown): void {
    this.transport.sendJson(value);
  }

  private openTransport(): void {
    const url = this.currentSessionId !== null
      ? buildResumeUrl(this.options.url, this.currentSessionId)
      : this.options.url;
    this.transport.connect(url);
  }

  private handleTransportOpen(): void {
    this.openedAt = Date.now();
    if (this.reconnectAttempt > 0) {
      const attempt = this.reconnectAttempt;
      this.reconnectAttempt = 0;
      this.emit({ type: "reconnected", attempt });
    } else {
      this.emit({ type: "open" });
    }
    this.startKeepalive();
  }

  private handleTransportClose(code: number, reason: string): void {
    this.stopKeepalive();
    if (this.cleanClose) {
      this.emit({ type: "close", code, reason });
      return;
    }
    this.scheduleReconnect(code, reason);
  }

  private handleTransportMessage(data: unknown): void {
    this.handleJsonMessage(data);
  }

  private handleTransportAudio(data: ArrayBuffer): void {
    this.handleBinaryMessage(data);
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
      this.openTransport();
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

  private startKeepalive(): void {
    this.stopKeepalive();
    const intervalMs = this.options.keepaliveIntervalMs;
    if (intervalMs === false) return;
    const ms = typeof intervalMs === "number" && intervalMs > 0 ? intervalMs : KEEPALIVE_INTERVAL_MS;
    this.keepaliveTimer = setInterval(() => {
      if (this.transport.connected) {
        this.transport.sendJson({ type: "ping" });
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

  private handleJsonMessage(data: unknown): void {
    if (typeof data !== "string") return;
    try {
      const message = parseStudioMessage(JSON.parse(data) as unknown);
      if (message.type === "ready") {
        if (message.sessionId !== undefined) this.currentSessionId = message.sessionId;
        if (message.audio?.outputSampleRateHz && message.audio.outputSampleRateHz !== this.outputSampleRateHz) {
          this.outputSampleRateHz = message.audio.outputSampleRateHz;
          if (this.options.audioContext) {
            this.jitterBuffer = new AudioJitterBuffer(this.options.audioContext, {
              sampleRateHz: this.outputSampleRateHz,
              ...this.options.jitterBuffer,
            });
          }
        }
        if (message.audio?.supportedInputCodecs?.includes("opus") && !this.opusLoadFailed) {
          this.codecNegotiation = this.negotiateWireCodec(message.audio).finally(() => {
            this.codecNegotiation = null;
            const pending = this.pendingUplink;
            this.pendingUplink = [];
            for (const send of pending) send();
          });
        } else {
          void this.negotiateWireCodec(message.audio);
        }
      }
      if ((message.type === "audio_clear" || message.type === "agent_interrupted") && this.jitterBuffer) {
        this.jitterBuffer.clear(message.turnId);
      }
      this.emit({ type: "message", message });
      if (message.type === "ready" && message.resumed === true) {
        this.emit({ type: "resumed" });
      }
    } catch (err) {
      this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    try {
      const audio = decodeBrowserAssistantAudio(data, this.opusCodec);
      let pcmData = audio.data;
      const wireRate = audio.metadata?.sampleRateHz;
      if (wireRate !== undefined && wireRate !== this.outputSampleRateHz) {
        const samples = pcm16BytesToSamples(new Uint8Array(pcmData));
        const resampled = pcm16SamplesToBytes(resamplePcm16(samples, wireRate, this.outputSampleRateHz));
        const copy = new Uint8Array(resampled.byteLength);
        copy.set(resampled);
        pcmData = copy.buffer;
      }
      this.handleAudioData(pcmData, audio.metadata);
    } catch (err) {
      this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  private scheduleUplink(send: () => void): void {
    if (this.codecNegotiation) {
      this.pendingUplink.push(send);
      return;
    }
    send();
  }

  private async negotiateWireCodec(audio: SyrinxReadyAudio): Promise<void> {
    if (!audio) return;
    this.inputSampleRateHz = audio.inputSampleRateHz;
    const supported = audio.supportedInputCodecs;
    if (!supported?.includes("opus") || this.opusLoadFailed) {
      this.wireCodec = "pcm_s16le";
      return;
    }
    try {
      this.opusCodec = await createBrowserOpusCodec(BROWSER_OPUS_SAMPLE_RATE_HZ);
      this.wireCodec = pickBrowserWireCodec(supported, true);
    } catch {
      this.opusLoadFailed = true;
      this.opusCodec = null;
      this.wireCodec = "pcm_s16le";
    }
  }

  private encodeUplinkPcm(
    bytes: Uint8Array,
    sampleRateHz: number,
    options: { readonly contextId?: string; readonly sequence?: number },
  ): Uint8Array[] {
    if (this.wireCodec === "opus" && this.opusCodec) {
      const frames: Uint8Array[] = [];
      let seq: number | undefined = options.sequence;
      const samples = pcm16BytesToSamples(bytes);
      const wireSamples = sampleRateHz === this.opusCodec.sampleRateHz
        ? samples
        : resamplePcm16(samples, sampleRateHz, this.opusCodec.sampleRateHz);
      for (const opus of this.opusCodec.encodePcm16Frame(wireSamples, true)) {
        const sequence = this.nextAudioSequence(seq);
        frames.push(encodeBrowserOpusEnvelope(opus, this.opusCodec.sampleRateHz, { ...options, sequence }));
        seq = sequence;
      }
      return frames;
    }
    const sequence = this.nextAudioSequence(options.sequence);
    return [encodeBrowserPcmEnvelope(bytes, sampleRateHz, { ...options, sequence })];
  }

  private requireOpenTransport(): ClientTransport {
    if (!this.transport.connected) {
      throw new Error("SyrinxBrowserClient transport is not connected");
    }
    return this.transport;
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

  private handleAudioData(data: ArrayBuffer, metadata?: BrowserAssistantAudio["metadata"]): void {
    if (this.jitterBuffer) {
      // Use jitter buffer for scheduled playback
      this.jitterBuffer.enqueue(data, metadata?.contextId);
    }
    // Always emit the audio event for applications that want raw access
    this.emit({ type: "audio", data, metadata });
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
  const encoding = value.encoding;
  if (encoding !== "pcm_s16le" && encoding !== "opus") {
    throw new Error("ready.audio.encoding must be pcm_s16le or opus");
  }
  return {
    inputSampleRateHz: requiredPositiveInteger(value.inputSampleRateHz, "ready.audio.inputSampleRateHz"),
    outputSampleRateHz: requiredPositiveInteger(value.outputSampleRateHz, "ready.audio.outputSampleRateHz"),
    encoding,
    supportedInputCodecs: parseSupportedInputCodecs(value.supportedInputCodecs),
    channels: requiredLiteral(value.channels, 1, "ready.audio.channels"),
    binaryEnvelope: value.binaryEnvelope === undefined
      ? undefined
      : requiredLiteral(value.binaryEnvelope, "syrinx.audio.v1", "ready.audio.binaryEnvelope"),
    rawBinaryInput: optionalBoolean(value.rawBinaryInput, "ready.audio.rawBinaryInput"),
  };
}

function parseSupportedInputCodecs(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("ready.audio.supportedInputCodecs must be an array of strings");
  }
  return value;
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
