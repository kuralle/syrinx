// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Test Fakes
//
// Fake implementations of VoicePlugin for testing the kernel without
// real provider connections. Each fake pushes scripted output into the bus.

import { Route, type PipelineBus, type VoicePlugin, type PluginConfig } from "@asyncdot/voice";

// =============================================================================
// Fake STT
// =============================================================================

export interface FakeSTTConfig extends PluginConfig {
  /** Scripted events to emit in order. */
  scriptedEvents: Array<
    | { kind: "interim"; text: string }
    | { kind: "final"; text: string; confidence: number; ts: number }
  >;
}

export class FakeSTT implements VoicePlugin {
  private config: FakeSTTConfig | null = null;
  private bus: PipelineBus | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.config = config as FakeSTTConfig;
  }

  /** Emit scripted events into the bus. Call after audio injection. */
  async emitScripted(contextId: string): Promise<void> {
    if (!this.bus || !this.config) return;
    for (const event of this.config.scriptedEvents) {
      if (event.kind === "interim") {
        this.bus.push(Route.Main, {
          kind: "stt.interim",
          contextId,
          timestampMs: Date.now(),
          text: event.text,
        });
      } else {
        this.bus.push(Route.Main, {
          kind: "stt.result",
          contextId,
          timestampMs: event.ts,
          text: event.text,
          confidence: event.confidence,
        });
        this.bus.push(Route.Main, {
          kind: "eos.turn_complete",
          contextId,
          timestampMs: event.ts,
          text: event.text,
          transcripts: [],
        });
      }
    }
  }

  async close(): Promise<void> {
    this.bus = null;
    this.config = null;
  }
}

// =============================================================================
// Fake TTS
// =============================================================================

export interface FakeTTSConfig extends PluginConfig {
  /** Scripted audio batches. Each batch is emitted when tts.text arrives. */
  scriptedAudioBatches: Array<{
    frame: { data: Int16Array; sampleRateHz: number; durationMs: number };
    final: boolean;
  }>;
}

export class FakeTTS implements VoicePlugin {
  private config: FakeTTSConfig | null = null;
  private bus: PipelineBus | null = null;
  private batchIndex = 0;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.config = config as FakeTTSConfig;

    // Listen for TTS text
    bus.on("tts.text", (pkt: unknown) => {
      this.emitNextBatch((pkt as { contextId?: string }).contextId ?? "");
    });
  }

  private emitNextBatch(contextId: string): void {
    if (!this.bus || !this.config) return;
    const batches = this.config.scriptedAudioBatches;
    if (this.batchIndex >= batches.length) return;

    const batch = batches[this.batchIndex]!;
    const buf = new Uint8Array(batch.frame.data.buffer);
    const now = Date.now();

    this.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId,
      timestampMs: now,
      audio: buf,
    });

    if (batch.final) {
      this.bus.push(Route.Main, {
        kind: "tts.end",
        contextId,
        timestampMs: now,
      });
    }

    this.batchIndex++;
  }

  async close(): Promise<void> {
    this.bus = null;
    this.config = null;
  }
}

// =============================================================================
// Fake VAD
// =============================================================================

export interface FakeVADConfig extends PluginConfig {
  /**
   * Array of speech probabilities, one per 20ms audio frame.
   * Value >= 0.5 → speech, < 0.5 → silence.
   */
  scriptedSpeechProbabilities: number[];
}

export class FakeVAD implements VoicePlugin {
  private config: FakeVADConfig | null = null;
  private bus: PipelineBus | null = null;
  private frameIndex = 0;
  private speaking = false;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.config = config as FakeVADConfig;
  }

  /** Process one frame and emit VAD events based on scripted probability. */
  processFrame(contextId: string): void {
    if (!this.bus || !this.config) return;
    const probs = this.config.scriptedSpeechProbabilities;
    if (this.frameIndex >= probs.length) return;

    const prob = probs[this.frameIndex]!;
    const isSpeech = prob >= 0.5;
    const now = Date.now();

    if (isSpeech && !this.speaking) {
      this.speaking = true;
      this.bus.push(Route.Main, {
        kind: "vad.speech_started",
        contextId,
        timestampMs: now,
        confidence: prob,
      });
    }

    if (!isSpeech && this.speaking) {
      this.speaking = false;
      this.bus.push(Route.Main, {
        kind: "vad.speech_ended",
        contextId,
        timestampMs: now,
      });
    }

    if (isSpeech) {
      this.bus.push(Route.Main, {
        kind: "vad.speech_activity",
        contextId,
        timestampMs: now,
        isAsync: true,
      });
    }

    this.frameIndex++;
  }

  async close(): Promise<void> {
    this.bus = null;
    this.config = null;
  }
}

// =============================================================================
// Fake Bridge (LLM)
// =============================================================================

export interface FakeBridgeConfig extends PluginConfig {
  /** Scripted LLM events in order. */
  scriptedEvents: Array<
    | { kind: "text"; delta: string }
    | { kind: "tool_call"; id: string; name: string; args: Record<string, unknown> }
    | { kind: "tool_result"; id: string; result: string }
    | { kind: "done" }
  >;
}

export class FakeBridge implements VoicePlugin {
  private config: FakeBridgeConfig | null = null;
  private bus: PipelineBus | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.config = config as FakeBridgeConfig;

    // Listen for EOS turn completions
    bus.on("eos.turn_complete", (pkt: unknown) => {
      const eos = pkt as { contextId: string };
      this.emitScripted(eos.contextId);
    });
  }

  private emitScripted(contextId: string): void {
    if (!this.bus || !this.config) return;
    for (const event of this.config.scriptedEvents) {
      switch (event.kind) {
        case "text":
          this.bus.push(Route.Main, {
            kind: "llm.delta",
            contextId,
            timestampMs: Date.now(),
            text: event.delta,
          });
          break;
        case "tool_call":
          this.bus.push(Route.Main, {
            kind: "llm.tool_call",
            contextId,
            timestampMs: Date.now(),
            toolId: event.id,
            toolName: event.name,
            toolArgs: event.args,
          });
          break;
        case "tool_result":
          this.bus.push(Route.Main, {
            kind: "llm.tool_result",
            contextId,
            timestampMs: Date.now(),
            toolId: event.id,
            toolName: "",
            result: event.result,
          });
          break;
        case "done":
          this.bus.push(Route.Main, {
            kind: "llm.done",
            contextId,
            timestampMs: Date.now(),
            text: "",
          });
          break;
      }
    }
  }

  async close(): Promise<void> {
    this.bus = null;
    this.config = null;
  }
}
