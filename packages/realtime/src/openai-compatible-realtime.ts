// SPDX-License-Identifier: MIT

import type { SocketFactory } from "@kuralle-syrinx/ws";
import { RealtimeSocket } from "@kuralle-syrinx/ws/realtime";

import { base64ToBytes, bytesToBase64 } from "./base64.js";
import type { RealtimeAdapter, RealtimeEvent } from "./realtime-adapter.js";

export interface OpenAiCompatibleRealtimeConfig {
  readonly apiKey: string;
  readonly socketFactory: SocketFactory;
  readonly debug?: boolean;
  readonly debugLogPrefix?: string;
  readonly defaultModel: string;
  readonly model?: string;
  readonly url?: () => string;
  readonly buildUrl?: (model: string) => string;
  readonly caps: RealtimeAdapter["caps"];
  readonly buildSessionUpdate: () => Record<string, unknown>;
  readonly supportsTruncate: boolean;
  readonly requiresResponseCreateAfterToolOutput?: boolean;
  readonly defaultErrorMessage: string;
  readonly extendServerMessage?: (
    type: string,
    msg: Record<string, unknown>,
    ctx: {
      push: (event: RealtimeEvent) => void;
      caps: RealtimeAdapter["caps"];
    },
  ) => boolean;
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

class OpenAiCompatibleRealtimeAdapter implements RealtimeAdapter {
  readonly caps: RealtimeAdapter["caps"];
  readonly events: AsyncIterable<RealtimeEvent>;

  private readonly stream = new RealtimeEventStream();
  private socket: RealtimeSocket | null = null;
  private abortHandler: (() => void) | null = null;
  private openResolver: (() => void) | null = null;
  private openRejecter: ((err: Error) => void) | null = null;
  private currentAssistantItemId: string | null = null;
  private assistantTranscript = "";
  private activeResponse = false;
  private pendingResponseCreate = false;

  constructor(private readonly config: OpenAiCompatibleRealtimeConfig) {
    this.events = this.stream;
    this.caps = config.caps;
  }

  async open(signal: AbortSignal): Promise<void> {
    const model = this.config.model ?? this.config.defaultModel;
    const url =
      this.config.url ??
      (this.config.buildUrl
        ? () => this.config.buildUrl!(model)
        : () => `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`);

    this.socket = new RealtimeSocket({
      url,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      socketFactory: this.config.socketFactory,
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
      session: this.config.buildSessionUpdate(),
    });

    await openPromise;
  }

  sendAudio(pcm16: Uint8Array): void {
    this.requireSocket().send({
      type: "input_audio_buffer.append",
      audio: bytesToBase64(pcm16),
    });
  }

  cancelResponse(audioEndMs: number): void {
    if (!this.activeResponse) return;
    const socket = this.requireSocket();
    socket.send({ type: "response.cancel" });
    if (this.config.supportsTruncate && this.currentAssistantItemId) {
      socket.send({
        type: "conversation.item.truncate",
        item_id: this.currentAssistantItemId,
        content_index: 0,
        audio_end_ms: audioEndMs,
      });
    }
    if (this.config.supportsTruncate) {
      this.currentAssistantItemId = null;
    }
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
    if (this.config.requiresResponseCreateAfterToolOutput !== false) {
      this.requestResponseCreate();
    }
  }

  async close(): Promise<void> {
    await this.socket?.close();
    this.socket = null;
    this.stream.close();
  }

  private requestResponseCreate(): void {
    if (this.activeResponse) {
      this.pendingResponseCreate = true;
      return;
    }
    this.requireSocket().send({ type: "response.create" });
    this.pendingResponseCreate = false;
  }

  private completeResponse(): void {
    this.activeResponse = false;
    if (this.config.supportsTruncate) {
      this.currentAssistantItemId = null;
    }
    if (this.pendingResponseCreate) {
      this.pendingResponseCreate = false;
      this.requireSocket().send({ type: "response.create" });
    }
  }

  private requireSocket(): RealtimeSocket {
    if (!this.socket) throw new Error("Realtime adapter is not open");
    return this.socket;
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
    if (this.config.debug) {
      console.error(`${this.config.debugLogPrefix ?? "[raw]"} ${type}`);
    }

    if (this.config.extendServerMessage?.(type, msg, { push: (e) => this.stream.push(e), caps: this.caps })) {
      return;
    }

    switch (type) {
      case "session.created":
      case "session.updated":
        this.resolveOpen();
        break;
      case "response.created":
        this.assistantTranscript = "";
        if (this.config.supportsTruncate) {
          this.currentAssistantItemId = null;
        }
        this.activeResponse = true;
        this.stream.push({ type: "response_started" });
        break;
      case "response.output_item.added": {
        if (!this.config.supportsTruncate) break;
        const item = msg["item"];
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (record["type"] === "message" && typeof record["id"] === "string") {
            this.currentAssistantItemId = record["id"];
          }
        }
        break;
      }
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
      case "input_audio_buffer.speech_started":
        this.stream.push({ type: "speech_started" });
        break;
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
        this.completeResponse();
        const toolCall = extractFunctionCall(msg["response"]);
        if (toolCall) {
          this.stream.push(toolCall);
        }
        this.stream.push({ type: "response_done" });
        break;
      }
      case "error": {
        const errObj = msg["error"];
        const message =
          errObj && typeof errObj === "object" && typeof (errObj as Record<string, unknown>)["message"] === "string"
            ? String((errObj as Record<string, unknown>)["message"])
            : this.config.defaultErrorMessage;
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

export function createOpenAiCompatibleRealtimeAdapter(
  config: OpenAiCompatibleRealtimeConfig,
): RealtimeAdapter {
  return new OpenAiCompatibleRealtimeAdapter(config);
}
