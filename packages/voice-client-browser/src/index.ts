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

export type SyrinxBrowserClientEvent =
  | { readonly type: "open" }
  | { readonly type: "close"; readonly code: number; readonly reason: string }
  | { readonly type: "error"; readonly error: Event }
  | { readonly type: "message"; readonly message: SyrinxStudioMessage }
  | { readonly type: "audio"; readonly data: ArrayBuffer; readonly metadata?: BrowserAssistantAudio["metadata"] };

export type SyrinxBrowserClientHandler = (event: SyrinxBrowserClientEvent) => void;

export interface SyrinxBrowserClientOptions {
  readonly url: string;
  readonly protocols?: string | readonly string[];
}

export class SyrinxBrowserClient {
  private socket: WebSocket | null = null;
  private readonly handlers = new Set<SyrinxBrowserClientHandler>();
  private audioSequence = 0;

  constructor(private readonly options: SyrinxBrowserClientOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
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

    const socket = new WebSocket(this.options.url, this.options.protocols as string | string[] | undefined);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.emit({ type: "open" });
    });
    socket.addEventListener("close", (event) => {
      this.emit({ type: "close", code: event.code, reason: event.reason });
    });
    socket.addEventListener("error", (event) => {
      this.emit({ type: "error", error: event });
    });
    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
  }

  close(code?: number, reason?: string): void {
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
    this.requireOpenSocket().send(encodeBrowserPcmEnvelope(bytes, sampleRate, options));
  }

  sendAudioBase64(
    audio: string,
    sampleRateHz: number,
    options: { readonly contextId?: string; readonly sequence?: number } = {},
  ): void {
    this.sendJson({ type: "audio", audio, sampleRateHz, contextId: options.contextId, sequence: options.sequence });
  }

  sendFloat32Audio(input: Float32Array, options: EncodeBrowserAudioOptions): void {
    const sequence = options.sequence ?? (this.audioSequence += 1);
    this.requireOpenSocket().send(encodeBrowserAudioEnvelopeFrame(input, { ...options, sequence }));
  }

  sendText(text: string): void {
    this.sendJson({ type: "text", text });
  }

  sendJson(value: unknown): void {
    this.requireOpenSocket().send(JSON.stringify(value));
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      const message = JSON.parse(data) as SyrinxStudioMessage;
      this.emit({ type: "message", message });
      return;
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => {
        const audio = decodeBrowserAssistantAudio(buffer);
        this.emit({ type: "audio", data: audio.data, metadata: audio.metadata });
      });
      return;
    }
    if (data instanceof ArrayBuffer) {
      const audio = decodeBrowserAssistantAudio(data);
      this.emit({ type: "audio", data: audio.data, metadata: audio.metadata });
    }
  }

  private requireOpenSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("SyrinxBrowserClient WebSocket is not open");
    }
    return this.socket;
  }

  private emit(event: SyrinxBrowserClientEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
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
