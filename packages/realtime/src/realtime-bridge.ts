// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";

import {
  Route,
  categorizeLlmError,
  type EndOfSpeechPacket,
  type InterruptTtsPacket,
  type InterruptionDetectedPacket,
  type LlmErrorPacket,
  type LlmToolCallPacket,
  type LlmToolResultPacket,
  type PipelineBus,
  type PluginConfig,
  type Reasoner,
  type UserAudioReceivedPacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TextToSpeechPlayoutProgressPacket,
  type TurnChangePacket,
  type VoicePlugin,
} from "@kuralle-syrinx/core";

import type { RealtimeAdapter, RealtimeEvent } from "./realtime-adapter.js";

const ENGINE_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES_20MS = 320;

export class RealtimeBridge implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private contextId = "";
  private turnUserText = "";
  private sessionAbort: AbortController | null = null;
  private inflight: AbortController | undefined;
  private playedMs = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly adapter: RealtimeAdapter,
    private readonly reasoner?: Reasoner,
    private readonly delegateToolName = "ask_university",
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
    } catch {
      // Pump ends when adapter closes or the session aborts.
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
        // Only the USER's final transcript is the turn's user text / stt.result.
        // The adapter currently emits assistant transcripts (the model's own speech); those are
        // not user input and must not be recorded as stt.result.
        if (ev.final && ev.role === "user") this.onFinalTranscript(bus, ev.text);
        break;
      case "tool_call":
        if (ev.toolName === this.delegateToolName && this.reasoner) {
          await this.runDelegate(bus, ev);
        }
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

    this.inflight = new AbortController();
    let answer = "";

    try {
      for await (const part of this.reasoner!.stream({
        userText: String(ev.args["query"] ?? ""),
        messages: [],
        signal: this.inflight.signal,
      })) {
        switch (part.type) {
          case "text-delta":
            answer += part.text;
            break;
          case "tool-result":
            break;
          case "finish":
            answer = answer || part.text;
            break;
          case "suspended":
            throw new Error("delegate suspended — cannot voice inline");
          case "error":
            if (!part.recoverable) throw part.cause;
            break;
        }
      }
    } catch (err) {
      if (isAbortError(err)) return;
      this.onError(bus, err instanceof Error ? err : new Error(String(err)), false);
      return;
    } finally {
      this.inflight = undefined;
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
    if (!this.contextId) return;
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
    this.contextId = randomUUID();
    this.turnUserText = "";
    this.playedMs = 0;
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
    for (const frame of chunkPcm16To20msFrames(resampled, ENGINE_SAMPLE_RATE_HZ)) {
      const packet: TextToSpeechAudioPacket = {
        kind: "tts.audio",
        contextId: this.contextId,
        timestampMs: Date.now(),
        audio: frame,
        sampleRateHz: ENGINE_SAMPLE_RATE_HZ,
      };
      bus.push(Route.Main, packet);
    }
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
    bus.push(Route.Main, turnComplete, ttsEnd);
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

function resamplePcm16Bytes(pcm16: Uint8Array, fromHz: number, toHz: number): Uint8Array {
  if (fromHz === toHz) return pcm16;
  const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength / 2);
  const out = resamplePcm16(samples, fromHz, toHz);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
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

function chunkPcm16To20msFrames(pcm16: Uint8Array, sampleRateHz: number): Uint8Array[] {
  const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength / 2);
  const frameSamples = sampleRateHz === ENGINE_SAMPLE_RATE_HZ
    ? FRAME_SAMPLES_20MS
    : Math.max(1, Math.round(sampleRateHz * 0.02));
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < samples.length; offset += frameSamples) {
    const end = Math.min(offset + frameSamples, samples.length);
    const slice = samples.subarray(offset, end);
    frames.push(new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength));
  }
  return frames;
}
