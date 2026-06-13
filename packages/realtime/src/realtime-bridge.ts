// SPDX-License-Identifier: MIT

import {
  Route,
  categorizeLlmError,
  type EndOfSpeechPacket,
  type InterruptTtsPacket,
  type InterruptionDetectedPacket,
  type LlmErrorPacket,
  type LlmDeltaPacket,
  type LlmResponseDonePacket,
  type LlmToolCallPacket,
  type LlmToolResultPacket,
  type PipelineBus,
  type PluginConfig,
  type Reasoner,
  type ReasonerMessage,
  type UserAudioReceivedPacket,
  type UserTextReceivedPacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TextToSpeechPlayoutProgressPacket,
  type TurnChangePacket,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import { pcm16BytesToSamples } from "@kuralle-syrinx/core/audio";

import type { RealtimeAdapter, RealtimeEvent } from "./realtime-adapter.js";

const ENGINE_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES_20MS = 320;
const FRAME_BYTES_20MS = FRAME_SAMPLES_20MS * 2;

export interface RealtimeBridgeOptions {
  readonly debug?: boolean;
  /**
   * Supplies prior conversation context for delegate Reasoner turns. When omitted the delegate is
   * stateless — each tool call receives only the query extracted from the front-model tool args.
   */
  readonly contextProvider?: () => readonly ReasonerMessage[];
  /**
   * Name of the front-model tool argument that carries the user's query for the delegate Reasoner.
   * Must match the argument name in the registered delegate tool's schema. Defaults to "query".
   */
  readonly delegateQueryArg?: string;
  /**
   * Handle a front-model tool call whose name is NOT the delegate tool — front-level tools like
   * `wait_for_user`, `escalate_to_human`, or `finish_session` that must not hit the reasoner.
   * Return the string to inject back to the front model as the tool result (default `""`). When
   * omitted, a non-delegate tool call remains a recoverable error (the prior behavior).
   */
  readonly onFrontToolCall?: (call: {
    readonly toolId: string;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
  }) => string | undefined | Promise<string | undefined>;
}

export class RealtimeBridge implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private contextId = "";
  private turnUserText = "";
  /** Authoritative full assistant transcript(s) — providers that emit a final transcript (OpenAI). */
  private turnAssistantText = "";
  /** Concatenated streamed transcript fragments — providers that emit deltas only, no final (Gemini Live). */
  private turnAssistantDeltas = "";
  private sessionAbort: AbortController | null = null;
  private inflight: AbortController | undefined;
  private playedMs = 0;
  private audioRemainder: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly adapter: RealtimeAdapter,
    private readonly reasoner?: Reasoner,
    private readonly delegateToolName = "consult_knowledge",
    private readonly opts: RealtimeBridgeOptions = {},
  ) {}

  async initialize(bus: PipelineBus, _cfg: PluginConfig): Promise<void> {
    this.bus = bus;
    this.sessionAbort = new AbortController();

    this.disposers.push(
      bus.on<UserAudioReceivedPacket>("user.audio_received", (pkt) => {
        const resampled = resamplePcm16Bytes(
          pkt.audio,
          ENGINE_SAMPLE_RATE_HZ,
          this.adapter.caps.inputSampleRateHz,
        );
        this.adapter.sendAudio(resampled);
      }),
      bus.on<UserTextReceivedPacket>("user.text_received", (pkt) => {
        if (pkt.text.trim().length > 0) this.adapter.sendText?.(pkt.text);
      }),
      bus.on<TextToSpeechPlayoutProgressPacket>("tts.playout_progress", (pkt) => {
        if (pkt.contextId === this.contextId) this.playedMs = pkt.playedOutMs;
      }),
      bus.on<InterruptTtsPacket>("interrupt.tts", () => {
        this.adapter.cancelResponse(this.playedMs);
        this.inflight?.abort();
      }),
    );

    await this.adapter.open(this.sessionAbort.signal);
    void this.pump();
  }

  async close(): Promise<void> {
    this.sessionAbort?.abort();
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.adapter.close();
    this.bus = null;
    this.sessionAbort = null;
  }

  private async pump(): Promise<void> {
    const bus = this.bus;
    if (!bus) return;

    try {
      for await (const ev of this.adapter.events) {
        if (!this.bus) return;
        await this.handleEvent(bus, ev);
      }
    } catch (err) {
      if (!this.bus || isAbortError(err)) return;
      this.onError(
        this.bus,
        err instanceof Error ? err : new Error(String(err)),
        false,
      );
    }
  }

  private async handleEvent(bus: PipelineBus, ev: RealtimeEvent): Promise<void> {
    switch (ev.type) {
      case "response_started":
        this.onResponseStarted(bus);
        break;
      case "audio":
        this.onAudio(bus, ev.pcm16, ev.sampleRateHz);
        break;
      case "transcript":
        if (ev.role === "user") {
          if (ev.final) this.onFinalTranscript(bus, ev.text);
        } else if (ev.final && ev.text.trim()) {
          this.turnAssistantText = this.turnAssistantText
            ? `${this.turnAssistantText} ${ev.text.trim()}`
            : ev.text.trim();
        } else if (!ev.final && ev.text) {
          // Streamed fragments already carry their own leading spaces — concatenate verbatim.
          this.turnAssistantDeltas += ev.text;
        }
        break;
      case "tool_call":
        await this.handleToolCall(bus, ev);
        break;
      case "response_done":
        this.onResponseDone(bus);
        break;
      case "speech_started":
        this.onSpeechStarted(bus);
        break;
      case "error":
        this.onError(bus, ev.cause, ev.recoverable);
        break;
      default:
        break;
    }
  }

  private async handleToolCall(
    bus: PipelineBus,
    ev: { toolId: string; toolName: string; args: Record<string, unknown> },
  ): Promise<void> {
    if (ev.toolName === this.delegateToolName) {
      if (this.reasoner) await this.runDelegate(bus, ev);
      return;
    }
    if (this.opts.onFrontToolCall) {
      await this.handleFrontTool(bus, ev);
      return;
    }
    // No front-tool handler: with a reasoner, an unexpected tool is a recoverable error
    // (without one, tool calls are ignored, as before).
    if (this.reasoner) {
      const cause = new Error(`Unexpected tool call "${ev.toolName}" (expected "${this.delegateToolName}")`);
      if (this.opts.debug) console.error("[realtime-bridge]", cause.message);
      this.onError(bus, cause, true);
    }
  }

  private async handleFrontTool(
    bus: PipelineBus,
    ev: { toolId: string; toolName: string; args: Record<string, unknown> },
  ): Promise<void> {
    if (!this.opts.onFrontToolCall) return;
    let result: string;
    try {
      result = (await this.opts.onFrontToolCall({ toolId: ev.toolId, toolName: ev.toolName, args: ev.args })) ?? "";
    } catch (err) {
      this.onError(bus, err instanceof Error ? err : new Error(String(err)), true);
      return;
    }
    this.adapter.injectToolResult(ev.toolId, result);
  }

  private async runDelegate(
    bus: PipelineBus,
    ev: { toolId: string; toolName: string; args: Record<string, unknown> },
  ): Promise<void> {
    if (!this.contextId) return;

    const toolCall: LlmToolCallPacket = {
      kind: "llm.tool_call",
      contextId: this.contextId,
      timestampMs: Date.now(),
      toolId: ev.toolId,
      toolName: ev.toolName,
      toolArgs: ev.args,
    };
    bus.push(Route.Main, toolCall);

    const queryArg = this.opts.delegateQueryArg ?? "query";
    const rawQuery = ev.args[queryArg];
    const userText = typeof rawQuery === "string" ? rawQuery : "";
    if (userText.trim().length === 0) {
      this.onError(
        bus,
        new Error(`delegate tool "${ev.toolName}" called without a string "${queryArg}" argument`),
        true,
      );
      return;
    }

    this.inflight = new AbortController();
    let answer = "";

    try {
      const messages = this.opts.contextProvider?.() ?? [];
      for await (const part of this.reasoner!.stream({
        userText,
        toolArgs: ev.args,
        messages,
        signal: this.inflight.signal,
      })) {
        switch (part.type) {
          case "text-delta":
            answer += part.text;
            break;
          case "tool-result":
            break;
          case "finish":
            if (!answer && part.text) answer = part.text;
            break;
          case "suspended": {
            const cause = new Error(
              part.prompt ?? "delegate suspended — cannot voice inline without resume",
            );
            if (this.opts.debug) console.error("[realtime-bridge]", cause.message, part.payload);
            this.onError(bus, cause, false);
            return;
          }
          case "error":
            if (!part.recoverable) throw part.cause;
            this.onError(bus, part.cause, true);
            return;
        }
      }
    } catch (err) {
      if (isAbortError(err)) return;
      this.onError(bus, err instanceof Error ? err : new Error(String(err)), false);
      return;
    } finally {
      this.inflight = undefined;
    }

    if (answer.length === 0) {
      this.onError(bus, new Error("delegate produced no output"), false);
      return;
    }

    const toolResult: LlmToolResultPacket = {
      kind: "llm.tool_result",
      contextId: this.contextId,
      timestampMs: Date.now(),
      toolId: ev.toolId,
      toolName: ev.toolName,
      result: answer,
    };
    bus.push(Route.Main, toolResult);
    this.adapter.injectToolResult(ev.toolId, answer);
  }

  private onSpeechStarted(bus: PipelineBus): void {
    if (!this.adapter.caps.emitsServerSpeechStarted || !this.contextId) return;
    const packet: InterruptionDetectedPacket = {
      kind: "interrupt.detected",
      contextId: this.contextId,
      timestampMs: Date.now(),
      source: "vad",
    };
    bus.push(Route.Critical, packet);
  }

  private onResponseStarted(bus: PipelineBus): void {
    const previousContextId = this.contextId;
    this.contextId = crypto.randomUUID();
    this.turnUserText = "";
    this.turnAssistantText = "";
    this.turnAssistantDeltas = "";
    this.playedMs = 0;
    this.audioRemainder = new Uint8Array(0);
    const packet: TurnChangePacket = {
      kind: "turn.change",
      contextId: this.contextId,
      previousContextId,
      reason: "realtime_response_started",
      timestampMs: Date.now(),
    };
    bus.push(Route.Main, packet);
  }

  private onAudio(bus: PipelineBus, pcm16: Uint8Array, sampleRateHz: number): void {
    if (!this.contextId) return;
    const resampled = resamplePcm16Bytes(pcm16, sampleRateHz, ENGINE_SAMPLE_RATE_HZ);
    this.audioRemainder = concatBytes(this.audioRemainder, resampled);
    this.emitCoalescedAudio(bus, false);
  }

  private onFinalTranscript(bus: PipelineBus, text: string): void {
    if (!this.contextId || text.trim().length === 0) return;
    this.turnUserText = text;
    const packet: SttResultPacket = {
      kind: "stt.result",
      contextId: this.contextId,
      timestampMs: Date.now(),
      text,
      confidence: 0,
    };
    bus.push(Route.Main, packet);
  }

  private onResponseDone(bus: PipelineBus): void {
    if (!this.contextId) return;
    this.emitCoalescedAudio(bus, true);
    this.audioRemainder = new Uint8Array(0);

    const timestampMs = Date.now();
    const transcripts: SttResultPacket[] = this.turnUserText
      ? [{
          kind: "stt.result",
          contextId: this.contextId,
          timestampMs,
          text: this.turnUserText,
          confidence: 0,
        }]
      : [];
    const turnComplete: EndOfSpeechPacket = {
      kind: "eos.turn_complete",
      contextId: this.contextId,
      timestampMs,
      text: this.turnUserText,
      transcripts,
    };
    const ttsEnd: TextToSpeechEndPacket = {
      kind: "tts.end",
      contextId: this.contextId,
      timestampMs,
    };
    // Surface the assistant's spoken transcript as agent text so UIs (e.g. the studio) render it.
    // The realtime adapter already produced the audio directly; these packets are display-only.
    // Prefer the authoritative final transcript (OpenAI); fall back to the streamed fragments for
    // providers that only emit non-final deltas (Gemini Live).
    const assistantText = this.turnAssistantText.trim() || this.turnAssistantDeltas.trim();
    if (assistantText) {
      const delta: LlmDeltaPacket = {
        kind: "llm.delta",
        contextId: this.contextId,
        timestampMs,
        text: assistantText,
      };
      const done: LlmResponseDonePacket = {
        kind: "llm.done",
        contextId: this.contextId,
        timestampMs,
        text: assistantText,
      };
      bus.push(Route.Main, delta, done);
    }
    bus.push(Route.Main, turnComplete, ttsEnd);
  }

  private emitCoalescedAudio(bus: PipelineBus, flush: boolean): void {
    if (!this.contextId) return;

    let buf = this.audioRemainder;
    if (buf.byteLength === 0) return;

    let processLen = buf.byteLength;
    if (processLen % 2 !== 0) {
      processLen -= 1;
    }
    if (processLen < 2) return;

    let offset = 0;
    while (offset + FRAME_BYTES_20MS <= processLen) {
      const frame = buf.subarray(offset, offset + FRAME_BYTES_20MS);
      this.pushAudioFrame(bus, frame);
      offset += FRAME_BYTES_20MS;
    }

    const trailingEven = processLen - offset;
    if (flush && trailingEven >= 2) {
      this.pushAudioFrame(bus, buf.subarray(offset, offset + trailingEven));
      offset += trailingEven;
    }

    const leftoverStart = offset;
    const leftoverEnd = buf.byteLength;
    this.audioRemainder =
      leftoverStart < leftoverEnd
        ? new Uint8Array(buf.subarray(leftoverStart, leftoverEnd))
        : new Uint8Array(0);
  }

  private pushAudioFrame(bus: PipelineBus, frame: Uint8Array): void {
    if (frame.byteLength % 2 !== 0 || frame.byteLength === 0) return;
    const packet: TextToSpeechAudioPacket = {
      kind: "tts.audio",
      contextId: this.contextId,
      timestampMs: Date.now(),
      audio: frame,
      sampleRateHz: ENGINE_SAMPLE_RATE_HZ,
    };
    bus.push(Route.Main, packet);
  }

  private onError(bus: PipelineBus, cause: Error, isRecoverable: boolean): void {
    const packet: LlmErrorPacket = {
      kind: "llm.error",
      contextId: this.contextId,
      timestampMs: Date.now(),
      component: "bridge",
      category: categorizeLlmError(cause),
      cause,
      isRecoverable,
    };
    bus.push(Route.Critical, packet);
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function resamplePcm16Bytes(pcm16: Uint8Array, fromHz: number, toHz: number): Uint8Array {
  if (fromHz === toHz) return new Uint8Array(pcm16);
  // pcm16 may be a view at an ODD byteOffset (decoded envelope payload) — `new Int16Array(buffer, offset)`
  // throws "start offset … multiple of 2". pcm16BytesToSamples copies via DataView, which is offset-safe.
  // It requires an even byteLength, so drop a trailing odd byte first (matches the prior truncating view).
  const even = pcm16.byteLength % 2 === 0 ? pcm16 : pcm16.subarray(0, pcm16.byteLength - 1);
  const samples = pcm16BytesToSamples(even);
  const out = resamplePcm16(samples, fromHz, toHz);
  const bytes = new Uint8Array(out.byteLength);
  bytes.set(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
  return bytes;
}

function resamplePcm16(samples: Int16Array, fromHz: number, toHz: number): Int16Array {
  if (fromHz === toHz) return samples;
  const outLength = Math.max(1, Math.round((samples.length * toHz) / fromHz));
  const out = new Int16Array(outLength);
  const ratio = fromHz / toHz;
  for (let i = 0; i < out.length; i += 1) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(samples.length - 1, lo + 1);
    const frac = src - lo;
    out[i] = Math.round(samples[lo]! * (1 - frac) + samples[hi]! * frac);
  }
  return out;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
