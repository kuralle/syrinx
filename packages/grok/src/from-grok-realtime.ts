// SPDX-License-Identifier: MIT

import type { SocketFactory } from "@kuralle-syrinx/ws";
import { RealtimeSocket } from "@kuralle-syrinx/ws/realtime";

import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef } from "@kuralle-syrinx/realtime";

import { base64ToBytes, bytesToBase64 } from "./base64.js";

const DEFAULT_MODEL = "grok-voice-latest";
const DEFAULT_VOICE = "eve";
const DEFAULT_SAMPLE_RATE_HZ = 24_000;

export interface GrokRealtimeOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly voice?: string;
  readonly socketFactory: SocketFactory;
  readonly url?: () => string;
  readonly turnDetection?: Record<string, unknown> | null;
  readonly tools?: readonly RealtimeToolDef[];
  readonly debug?: boolean;
  readonly instructions?: string;
  readonly inputRateHz?: number;
  readonly outputRateHz?: number;
}

class RealtimeEventStream implements AsyncIterable<RealtimeEvent> {
  private readonly queue: RealtimeEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<RealtimeEvent>) => void> = [];
  private closed = false;

  push(event: RealtimeEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
    return {
      next: () =>
        new Promise<IteratorResult<RealtimeEvent>>((resolve) => {
          if (this.queue.length > 0) {
            resolve({ value: this.queue.shift()!, done: false });
            return;
          }
          if (this.closed) {
            resolve({ value: undefined, done: true });
            return;
          }
          this.waiters.push(resolve);
        }),
    };
  }
}

class GrokRealtimeAdapter implements RealtimeAdapter {
  readonly caps: RealtimeAdapter["caps"];
  readonly events: AsyncIterable<RealtimeEvent>;
  private readonly stream = new RealtimeEventStream();
  private socket: RealtimeSocket | null = null;
  private abortHandler: (() => void) | null = null;
  private openResolver: (() => void) | null = null;
  private openRejecter: ((err: Error) => void) | null = null;
  private assistantTranscript = "";
  private activeResponse = false;

  constructor(private readonly opts: GrokRealtimeOptions) {
    this.events = this.stream;
    const inputRateHz = opts.inputRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    const outputRateHz = opts.outputRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    this.caps = {
      inputSampleRateHz: inputRateHz,
      outputSampleRateHz: outputRateHz,
      supportsConcurrentToolAudio: false,
      supportsTruncate: false,
    };
  }

  async open(signal: AbortSignal): Promise<void> {
    const model = this.opts.model ?? DEFAULT_MODEL;
    const voice = this.opts.voice ?? DEFAULT_VOICE;
    const inputRateHz = this.opts.inputRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    const outputRateHz = this.opts.outputRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    const url =
      this.opts.url ??
      (() => `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`);

    this.socket = new RealtimeSocket({
      url,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      socketFactory: this.opts.socketFactory,
      onMessage: (json) => this.handleServerMessage(json),
      onConnectionLost: (err) => {
        this.stream.push({ type: "error", cause: err, recoverable: true });
        this.rejectOpen(err);
      },
      onUnrecoverable: (err) => {
        this.stream.push({ type: "error", cause: err, recoverable: false });
        this.rejectOpen(err);
      },
    });

    const openPromise = new Promise<void>((resolve, reject) => {
      this.openResolver = resolve;
      this.openRejecter = reject;
    });

    this.abortHandler = () => {
      void this.close();
      this.rejectOpen(new Error("Realtime adapter open aborted"));
    };
    signal.addEventListener("abort", this.abortHandler, { once: true });

    await this.socket.connect();
    this.socket.send({
      type: "session.update",
      session: this.buildSessionUpdate(voice, inputRateHz, outputRateHz),
    });

    await openPromise;
  }

  sendAudio(pcm16: Uint8Array): void {
    this.requireSocket().send({
      type: "input_audio_buffer.append",
      audio: bytesToBase64(pcm16),
    });
  }

  cancelResponse(_audioEndMs: number): void {
    if (!this.activeResponse) return;
    this.requireSocket().send({ type: "response.cancel" });
    this.activeResponse = false;
  }

  injectToolResult(toolId: string, text: string): void {
    const socket = this.requireSocket();
    socket.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolId,
        output: text,
      },
    });
    socket.send({ type: "response.create" });
  }

  private buildSessionUpdate(
    voice: string,
    inputRateHz: number,
    outputRateHz: number,
  ): Record<string, unknown> {
    const turnDetection =
      "turnDetection" in this.opts ? this.opts.turnDetection : { type: "server_vad" };

    const session: Record<string, unknown> = {
      voice,
      turn_detection: turnDetection,
      tools: (this.opts.tools ?? []).map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      audio: {
        input: { format: { type: "audio/pcm", rate: inputRateHz } },
        output: { format: { type: "audio/pcm", rate: outputRateHz }, voice },
      },
    };

    if (this.opts.instructions !== undefined) {
      session["instructions"] = this.opts.instructions;
    }

    return session;
  }

  private requireSocket(): RealtimeSocket {
    if (!this.socket) throw new Error("Realtime adapter is not open");
    return this.socket;
  }

  async close(): Promise<void> {
    await this.socket?.close();
    this.socket = null;
    this.stream.close();
  }

  private rejectOpen(err: Error): void {
    this.openRejecter?.(err);
    this.openResolver = null;
    this.openRejecter = null;
  }

  private resolveOpen(): void {
    this.openResolver?.();
    this.openResolver = null;
    this.openRejecter = null;
  }

  private handleServerMessage(json: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(json) as Record<string, unknown>;
    } catch (err) {
      this.stream.push({
        type: "error",
        cause: err instanceof Error ? err : new Error(String(err)),
        recoverable: false,
      });
      return;
    }

    const type = typeof msg["type"] === "string" ? msg["type"] : "";
    if (this.opts.debug) console.error(`[grok-raw] ${type}`);
    switch (type) {
      case "session.created":
      case "session.updated":
        this.resolveOpen();
        break;
      case "response.created":
        this.assistantTranscript = "";
        this.activeResponse = true;
        this.stream.push({ type: "response_started" });
        break;
      case "response.output_audio.delta": {
        const delta = msg["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          this.stream.push({
            type: "audio",
            pcm16: base64ToBytes(delta),
            sampleRateHz: this.caps.outputSampleRateHz,
          });
        }
        break;
      }
      case "conversation.item.input_audio_transcription.updated": {
        const transcript = typeof msg["transcript"] === "string" ? msg["transcript"] : "";
        if (transcript.length > 0) {
          this.stream.push({
            type: "transcript",
            role: "user",
            text: transcript,
            final: true,
          });
        }
        break;
      }
      case "response.output_audio_transcript.delta": {
        const delta = msg["delta"];
        if (typeof delta === "string" && delta.length > 0) {
          this.assistantTranscript += delta;
          this.stream.push({
            type: "transcript",
            role: "assistant",
            text: delta,
            final: false,
          });
        }
        break;
      }
      case "response.output_audio_transcript.done": {
        const transcript =
          typeof msg["transcript"] === "string" ? msg["transcript"] : this.assistantTranscript;
        this.stream.push({
          type: "transcript",
          role: "assistant",
          text: transcript,
          final: true,
        });
        this.assistantTranscript = "";
        break;
      }
      case "response.done": {
        this.activeResponse = false;
        const toolCall = extractFunctionCall(msg["response"]);
        if (toolCall) this.stream.push(toolCall);
        this.stream.push({ type: "response_done" });
        break;
      }
      case "error": {
        const errObj = msg["error"];
        const message =
          errObj && typeof errObj === "object" && typeof (errObj as Record<string, unknown>)["message"] === "string"
            ? String((errObj as Record<string, unknown>)["message"])
            : "Grok Realtime error";
        const code =
          errObj && typeof errObj === "object" ? (errObj as Record<string, unknown>)["code"] : undefined;
        const recoverable = code !== "invalid_api_key" && code !== "authentication_failed";
        this.stream.push({
          type: "error",
          cause: new Error(message),
          recoverable,
        });
        break;
      }
      default:
        break;
    }
  }
}

function extractFunctionCall(response: unknown): RealtimeEvent | null {
  if (!response || typeof response !== "object") return null;
  const output = (response as Record<string, unknown>)["output"];
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record["type"] !== "function_call") continue;
    const toolId = typeof record["call_id"] === "string" ? record["call_id"] : "";
    const toolName = typeof record["name"] === "string" ? record["name"] : "";
    const argsRaw = typeof record["arguments"] === "string" ? record["arguments"] : "{}";
    if (!toolId || !toolName) continue;
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(argsRaw);
      args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    return { type: "tool_call", toolId, toolName, args };
  }
  return null;
}

export function fromGrokRealtime(opts: GrokRealtimeOptions): RealtimeAdapter {
  return new GrokRealtimeAdapter(opts);
}

export { base64ToBytes, bytesToBase64 };
