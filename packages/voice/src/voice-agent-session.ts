// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Voice Agent Session
//
// The central orchestrator. Wires together PipelineBus, plugins, init chain,
// error handler, idle timeout, mode switcher, and debug event stream.
//
// Breaking changes from v0.1:
//   - Plugins accept PipelineBus directly (no callbacks).
//   - Explicit init/finalize chains with stage-level error reporting.
//   - Categorized errors with recoverable flag.
//   - Priority bus with Critical/Main/Background routes.
//   - Unified ConversationEvent debug stream.
//   - Idle timeout with consecutive backoff.
//   - Mode switching (text ↔ audio).
//
// Backward compat: on/off event emitter stays for client-side consumers
// (bridges bus packets to legacy event names like "user_started_speaking").

import { PipelineBusImpl, Route, type PipelineBus } from "./pipeline-bus.js";
import { runInitChain, runFinalizeChain, type InitStep } from "./init-chain.js";
import type { VoicePlugin, PluginConfig } from "./plugin-contract.js";
import { IdleTimeoutManager, type IdleTimeoutConfig } from "./idle-timeout.js";
import { ModeSwitcher } from "./mode-switcher.js";
import { createConversationEventStream, type ConversationEvent } from "./conversation-event.js";
import { isRecoverable } from "./error-handler.js";
import type {
  VoicePacket,
  VoiceErrorPacket,
  UserAudioReceivedPacket,
  UserTextReceivedPacket,
  InterruptionDetectedPacket,
  InterruptTtsPacket,
  InterruptLlmPacket,
  LlmDeltaPacket,
  LlmResponseDonePacket,
  LlmToolCallPacket,
  LlmToolResultPacket,
  TextToSpeechAudioPacket,
  TextToSpeechTextPacket,
  TextToSpeechDonePacket,
  TextToSpeechEndPacket,
  RecordAssistantAudioPacket,
  RecordUserAudioPacket,
  SpeechToTextAudioPacket,
  SttResultPacket,
  SttInterimPacket,
  VadAudioPacket,
  VadSpeechStartedPacket,
  VadSpeechActivityPacket,
  VadSpeechEndedPacket,
  EndOfSpeechAudioPacket,
  EndOfSpeechPacket,
  InterimEndOfSpeechPacket,
  UserInputPacket,
  InjectMessagePacket,
  DisconnectRequestedPacket,
  InitializationFailedPacket,
  ModeSwitchRequestedPacket,
  StartIdleTimeoutPacket,
  StopIdleTimeoutPacket,
} from "./packets.js";
import {
  SessionState,
  InitStage,
  ErrorCategory,
} from "./packets.js";

// =============================================================================
// Types
// =============================================================================

export interface VoiceAgentSessionConfig {
  /** Plugin configurations, keyed by plugin name. */
  plugins: Record<string, PluginConfig>;
  /** Idle timeout configuration. */
  idleTimeout?: Partial<IdleTimeoutConfig>;
  /** PipelineBus configuration. */
  busConfig?: {
    mainCapacity?: number;
    bgCapacity?: number;
    criticalBatchSize?: number;
  };
  /**
   * Maximum ms to wait for an STT final transcript after audio injection stops.
   * When this timer fires, asks the streaming STT provider to flush buffered audio.
   * Default: 7000 (endpointing + 2s grace)
   */
  sttForceFinalizeTimeoutMs?: number;
  /**
   * Minimum sustained user-speech duration (ms) during assistant playback before a
   * barge-in is committed. Filters transient noise, clicks, and very short blips that
   * would otherwise falsely cut off the agent. The agent keeps speaking until the
   * user's speech is sustained past this threshold, then interruption fires
   * immediately. Set to 0 to disable the gate and interrupt on the first VAD speech
   * frame (legacy behavior). Default: 280 ms.
   */
  minInterruptionMs?: number;
  /**
   * Maximum ms after a user turn ends to wait for first assistant audio before
   * emitting a vaqi.missed_response metric (VAQI-M). 0 disables the check.
   * Default: 4000.
   */
  vaqiMissedResponseMs?: number;
}

export interface VoiceAgentSessionEvents {
  user_started_speaking: (event: { tsMs: number; turnId: string }) => void;
  user_stopped_speaking: (event: { tsMs: number; turnId: string }) => void;
  user_input_partial: (event: { tsMs: number; turnId: string; text: string }) => void;
  user_input_final: (event: { tsMs: number; turnId: string; text: string; confidence: number }) => void;
  agent_text_delta: (event: { tsMs: number; turnId: string; delta: string }) => void;
  agent_tool_call: (event: { tsMs: number; turnId: string; id: string; name: string; args: Record<string, unknown> }) => void;
  agent_tool_result: (event: { tsMs: number; turnId: string; id: string; result: string; durationMs: number }) => void;
  agent_first_audio: (event: { tsMs: number; turnId: string }) => void;
  agent_finished: (event: { tsMs: number; turnId: string } & Record<string, unknown>) => void;
  error: (event: { tsMs: number; stage: string; category: string; message: string }) => void;
  closed: (event: { tsMs: number; reason: string }) => void;
  state_changed: (event: { tsMs: number; from: SessionState; to: SessionState }) => void;
}

type EventHandler<T> = (event: T) => void;

interface TtsTextBuffer {
  pending: string;
  emitted: string;
}

interface SentenceSegment {
  segment: string;
}

// =============================================================================
// Session Implementation
// =============================================================================

export class VoiceAgentSession {
  readonly bus: PipelineBus;
  readonly debugEvents: ReadableStream<ConversationEvent>;
  private readonly config: VoiceAgentSessionConfig;
  private readonly sttForceFinalizeTimeoutMs: number;
  private _state: SessionState = SessionState.Uninitialized;
  private plugins: Map<string, VoicePlugin> = new Map();
  private initSteps: InitStep[] = [];
  private idleTimeout: IdleTimeoutManager;
  private modeSwitcher: ModeSwitcher;
  private debugPush: (event: ConversationEvent) => void;
  private eventListeners = new Map<string, Set<EventHandler<unknown>>>();
  private currentTurnId = "";
  private busStartPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private sttForceFinalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSttContextId = "";
  private activeTtsContextIds = new Set<string>();
  private interruptedGenerationContextIds = new Set<string>();
  private ttsTextBuffers = new Map<string, TtsTextBuffer>();
  private readonly minInterruptionMs: number;
  private pendingInterruption: {
    userContextId: string;
    interruptedContextId: string;
    firstSpeechMs: number;
  } | null = null;
  private readonly vaqiMissedResponseMs: number;
  private turnUserStoppedAtMs = new Map<string, number>();
  private firstTtsAudioFired = new Set<string>();
  private vaqiMissedResponseTimer: ReturnType<typeof setTimeout> | null = null;
  private vaqiMissedResponseContextId = "";
  private vaqiMissedResponseStartMs = 0;

  constructor(config: VoiceAgentSessionConfig) {
    this.config = config;
    this.sttForceFinalizeTimeoutMs = config.sttForceFinalizeTimeoutMs ?? 7000;
    this.minInterruptionMs = config.minInterruptionMs ?? 280;
    this.vaqiMissedResponseMs = config.vaqiMissedResponseMs ?? 4000;

    // Debug events
    const [stream, push] = createConversationEventStream();
    this.debugEvents = stream;
    this.debugPush = push;

    // PipelineBus
    this.bus = new PipelineBusImpl({
      ...config.busConfig,
      onPacket: (route, packet) => {
        this.debugPush({
          component: "bus",
          type: "packet",
          data: {
            context_id: packet.contextId,
            route: Route[route] ?? String(route),
            kind: packet.kind,
          },
          timestampMs: packet.timestampMs,
        });
      },
      onBackgroundDrop: (dropped) => {
        this.debugPush({
          component: "pipeline",
          type: "background_dropped",
          data: {
            context_id: dropped.contextId,
            kind: dropped.kind,
          },
          timestampMs: Date.now(),
        });
      },
    });

    // Idle timeout — starts after bus handlers are wired
    this.idleTimeout = new IdleTimeoutManager(this.bus, config.idleTimeout);

    // Mode switcher
    this.modeSwitcher = new ModeSwitcher(this.bus);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  get state(): SessionState {
    return this._state;
  }

  /** Register a plugin. Must be called before start(). */
  registerPlugin(name: string, plugin: VoicePlugin): void {
    this.plugins.set(name, plugin);
  }

  /** Start the session. Runs init chain, starts bus draining. */
  async start(): Promise<void> {
    if (this._state !== SessionState.Uninitialized) {
      throw new Error(`Cannot start session in state ${this._state}`);
    }
    this._state = SessionState.Initializing;

    // 1. Wire all bus handlers
    this.wireBusHandlers();

    // 2. Start bus drain loop
    this.busStartPromise = this.bus.start();

    // 3. Build init chain from registered plugins
    this.buildInitChain();

    // 4. Run init chain
    try {
      await runInitChain(this.bus, this.initSteps);
    } catch (err) {
      this._state = SessionState.Failed;
      throw err;
    }

    this._state = SessionState.Ready;
  }

  /** Shut down the session. Runs finalize chain in reverse order. */
  async close(): Promise<void> {
    if (this._state === SessionState.Closed) return;
    if (this.closePromise) return await this.closePromise;
    this.closePromise = this.closeOnce();
    return await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this._state = SessionState.Finalizing;

    // 1. Stop idle timeout
    this.idleTimeout.dispose();
    this.clearSttForceFinalizeTimer();
    this.clearVaqiMissedResponseTimer();
    this.turnUserStoppedAtMs.clear();
    this.firstTtsAudioFired.clear();
    this.ttsTextBuffers.clear();
    this.interruptedGenerationContextIds.clear();

    // 2. Run finalize chain (reverse order)
    await runFinalizeChain(this.initSteps);

    // 3. Stop bus
    this.bus.stop();
    await this.busStartPromise;

    // 4. Emit debug event
    this.emitDebug("session", "disconnected", { reason: "close" });

    this._state = SessionState.Closed;
  }

  /** Switch between text and audio mode. */
  async switchMode(mode: "text" | "audio"): Promise<void> {
    const pkt: ModeSwitchRequestedPacket = {
      kind: "mode.switch_requested",
      contextId: this.currentTurnId,
      timestampMs: Date.now(),
      mode,
    };
    this.bus.push(Route.Main, pkt);
  }

  // =========================================================================
  // Legacy Event Emitter (client-side consumers)
  // =========================================================================

  on<K extends keyof VoiceAgentSessionEvents>(
    event: K,
    handler: VoiceAgentSessionEvents[K],
  ): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler as EventHandler<unknown>);
  }

  off<K extends keyof VoiceAgentSessionEvents>(
    event: K,
    handler: VoiceAgentSessionEvents[K],
  ): void {
    this.eventListeners.get(event)?.delete(handler as EventHandler<unknown>);
  }

  private emit<K extends keyof VoiceAgentSessionEvents>(
    event: K,
    payload: Parameters<VoiceAgentSessionEvents[K]>[0],
  ): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    for (const fn of listeners) {
      try {
        (fn as EventHandler<unknown>)(payload);
      } catch {
        // Don't let listener errors crash the session
      }
    }
  }

  // =========================================================================
  // Bus Handler Wiring
  // =========================================================================

  private wireBusHandlers(): void {
    // Input pipeline
    this.bus.on("user.audio_received", this.handleUserAudio.bind(this));
    this.bus.on("user.text_received", this.handleUserText.bind(this));

    // STT results
    this.bus.on("stt.audio", this.handleSttAudio.bind(this));
    this.bus.on("stt.interim", this.handleSttInterim.bind(this));
    this.bus.on("stt.result", this.handleSttResult.bind(this));

    // VAD
    this.bus.on("vad.speech_started", this.handleVadSpeechStarted.bind(this));
    this.bus.on("vad.speech_activity", this.handleVadSpeechActivity.bind(this));
    this.bus.on("vad.speech_ended", this.handleVadSpeechEnded.bind(this));

    // EOS
    this.bus.on("eos.turn_complete", this.handleTurnComplete.bind(this));
    this.bus.on("eos.interim", this.handleEosInterim.bind(this));

    // LLM
    this.bus.on("llm.delta", this.handleLlmDelta.bind(this));
    this.bus.on("llm.done", this.handleLlmDone.bind(this));
    this.bus.on("llm.tool_call", this.handleLlmToolCall.bind(this));
    this.bus.on("llm.tool_result", this.handleLlmToolResult.bind(this));

    // TTS
    this.bus.on("tts.audio", this.handleTtsAudio.bind(this));
    this.bus.on("tts.end", this.handleTtsEnd.bind(this));

    // Interrupts
    this.bus.on("interrupt.detected", this.handleInterruptDetected.bind(this));

    // Errors
    this.bus.on("stt.error", this.handleComponentError.bind(this));
    this.bus.on("tts.error", this.handleComponentError.bind(this));
    this.bus.on("vad.error", this.handleComponentError.bind(this));
    this.bus.on("llm.error", this.handleComponentError.bind(this));
    this.bus.on("pipeline.error", this.handleComponentError.bind(this));

    // Lifecycle
    this.bus.on("init.failed", this.handleInitFailed.bind(this));

    // Behavior
    this.bus.on("behavior.idle_timeout_start", (pkt: unknown) => {
      this.idleTimeout.handleStart(pkt as StartIdleTimeoutPacket);
    });
    this.bus.on("behavior.idle_timeout_stop", (pkt: unknown) => {
      this.idleTimeout.handleStop(pkt as StopIdleTimeoutPacket);
    });

    // Injected messages — push through LLM path for natural TTS
    this.bus.on("inject.message", this.handleInjectMessage.bind(this));

    // Disconnect
    this.bus.on("session.disconnect", this.handleDisconnect.bind(this));

    // Mode switching
    this.bus.on("mode.switch_requested", async (pkt: unknown) => {
      await this.modeSwitcher.handleSwitchRequested(pkt as ModeSwitchRequestedPacket);
    });
  }

  // =========================================================================
  // Handler Implementations
  // =========================================================================

  private handleUserAudio(pkt: UserAudioReceivedPacket): void {
    this.bus.push(
      Route.Main,
      {
        kind: "record.user_audio",
        contextId: pkt.contextId,
        timestampMs: pkt.timestampMs,
        audio: pkt.audio,
      } as RecordUserAudioPacket,
      {
        kind: "vad.audio",
        contextId: pkt.contextId,
        timestampMs: pkt.timestampMs,
        audio: pkt.audio,
      } as VadAudioPacket,
      {
        kind: "stt.audio",
        contextId: pkt.contextId,
        timestampMs: pkt.timestampMs,
        audio: pkt.audio,
      } as SpeechToTextAudioPacket,
      {
        kind: "eos.audio",
        contextId: pkt.contextId,
        timestampMs: pkt.timestampMs,
        audio: pkt.audio,
      } as EndOfSpeechAudioPacket,
    );

    this.debugPush({
      component: "input",
      type: "audio_received",
      data: { context_id: pkt.contextId, bytes: String(pkt.audio.length) },
      timestampMs: pkt.timestampMs,
    });
  }

  private handleSttAudio(pkt: SpeechToTextAudioPacket): void {
    this.scheduleSttForceFinalize(pkt.contextId);
  }

  private handleUserText(pkt: UserTextReceivedPacket): void {
    // Treat text input as an immediate EOS turn complete
    this.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: pkt.contextId,
      timestampMs: pkt.timestampMs,
      text: pkt.text,
      transcripts: [] as readonly SttResultPacket[],
    } as EndOfSpeechPacket);
  }

  private handleSttInterim(pkt: SttInterimPacket): void {
    this.currentTurnId = pkt.contextId;
    this.emit("user_input_partial", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
      text: pkt.text,
    });
    this.debugPush({
      component: "stt",
      type: "interim",
      data: { context_id: pkt.contextId, text: pkt.text },
      timestampMs: pkt.timestampMs,
    });
  }

  private handleSttResult(pkt: SttResultPacket): void {
    if (this.pendingSttContextId === pkt.contextId) {
      this.clearSttForceFinalizeTimer();
    }
    this.currentTurnId = pkt.contextId;
    this.emit("user_input_final", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
      text: pkt.text,
      confidence: pkt.confidence,
    });
    this.debugPush({
      component: "stt",
      type: "final",
      data: {
        context_id: pkt.contextId,
        text: pkt.text,
        confidence: String(pkt.confidence),
      },
      timestampMs: pkt.timestampMs,
    });
  }

  private handleVadSpeechStarted(pkt: VadSpeechStartedPacket): void {
    this.emit("user_started_speaking", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
    });
    this.debugPush({
      component: "vad",
      type: "speech_started",
      data: {
        context_id: pkt.contextId,
        confidence: String(pkt.confidence),
      },
      timestampMs: pkt.timestampMs,
    });

    const interruptedContextId = this.latestActiveTtsContextId();
    if (!interruptedContextId) return;

    if (this.minInterruptionMs <= 0) {
      // Gate disabled — interrupt on the first VAD speech frame (legacy behavior).
      this.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: interruptedContextId,
        timestampMs: Date.now(),
        name: "vaqi.interruption",
        value: "1",
      });
      this.emitInterruptDetected(interruptedContextId);
      return;
    }

    // Defer the cut until the user's speech is sustained past minInterruptionMs.
    // VAD emits `vad.speech_activity` per speech frame (never during silence), so a
    // transient noise spike / click / very short blip produces only a few activity
    // frames and then `vad.speech_ended` — which cancels this pending interruption
    // instead of cutting off the agent. Sustained speech keeps emitting activity and
    // crosses the threshold in handleVadSpeechActivity.
    this.pendingInterruption = {
      userContextId: pkt.contextId,
      interruptedContextId,
      firstSpeechMs: pkt.timestampMs,
    };
  }

  private handleVadSpeechActivity(pkt: VadSpeechActivityPacket): void {
    const pending = this.pendingInterruption;
    if (!pending || pending.userContextId !== pkt.contextId) return;
    if (pkt.timestampMs - pending.firstSpeechMs < this.minInterruptionMs) return;

    // Sustained speech — resolve the pending interruption.
    this.pendingInterruption = null;
    const sustainedMs = pkt.timestampMs - pending.firstSpeechMs;

    if (!this.activeTtsContextIds.has(pending.interruptedContextId)) {
      // The assistant finished speaking on its own during the gate window; there is
      // nothing left to interrupt. Record it rather than firing a stale barge-in.
      this.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: pending.interruptedContextId,
        timestampMs: Date.now(),
        name: "interrupt.gate_resolved_after_tts_end",
        value: String(sustainedMs),
      });
      return;
    }

    this.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: pending.interruptedContextId,
      timestampMs: Date.now(),
      name: "interrupt.committed_after_ms",
      value: String(sustainedMs),
    });
    this.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: pending.interruptedContextId,
      timestampMs: Date.now(),
      name: "vaqi.interruption",
      value: "1",
    });
    this.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: pending.interruptedContextId,
      timestampMs: Date.now(),
      name: "interrupt.latency_ms",
      value: String(sustainedMs),
    });
    this.emitInterruptDetected(pending.interruptedContextId);
  }

  private emitInterruptDetected(interruptedContextId: string): void {
    this.bus.push(Route.Critical, {
      kind: "interrupt.detected",
      contextId: interruptedContextId,
      timestampMs: Date.now(),
      source: "vad",
    } as InterruptionDetectedPacket);
  }

  private handleVadSpeechEnded(pkt: VadSpeechEndedPacket): void {
    this.emit("user_stopped_speaking", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
    });
    this.debugPush({
      component: "vad",
      type: "speech_ended",
      data: { context_id: pkt.contextId },
      timestampMs: pkt.timestampMs,
    });

    const pending = this.pendingInterruption;
    if (pending && pending.userContextId === pkt.contextId) {
      // Speech ended before sustaining past the gate: a non-interrupting blip
      // (transient noise / very short backchannel). Leave assistant playback running.
      this.pendingInterruption = null;
      this.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: pending.interruptedContextId,
        timestampMs: Date.now(),
        name: "interrupt.suppressed_short_speech",
        value: String(pkt.timestampMs - pending.firstSpeechMs),
      });
    }

    this.turnUserStoppedAtMs.set(pkt.contextId, pkt.timestampMs);
    if (this.vaqiMissedResponseMs > 0) {
      this.startVaqiMissedResponseTimer(pkt.contextId, pkt.timestampMs);
    }
  }

  private handleTurnComplete(pkt: EndOfSpeechPacket): void {
    this.currentTurnId = pkt.contextId;
    this.idleTimeout.setContextId(pkt.contextId);

    this.emit("user_input_final", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
      text: pkt.text,
      confidence: 1.0,
    });
    this.debugPush({
      component: "eos",
      type: "turn_complete",
      data: { context_id: pkt.contextId, text: pkt.text },
      timestampMs: pkt.timestampMs,
    });

    // Stop idle timeout while LLM is processing
    this.bus.push(Route.Main, {
      kind: "behavior.idle_timeout_stop",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      resetCount: false,
    } as StopIdleTimeoutPacket);

    this.bus.push(Route.Main, {
      kind: "user.input",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      text: pkt.text,
      language: languageFromTranscripts(pkt.transcripts),
    } as UserInputPacket);
  }

  private handleEosInterim(pkt: InterimEndOfSpeechPacket): void {
    this.debugPush({
      component: "eos",
      type: "interim",
      data: { context_id: pkt.contextId, text: pkt.text },
      timestampMs: pkt.timestampMs,
    });
  }

  private handleLlmDelta(pkt: LlmDeltaPacket): void {
    if (this.interruptedGenerationContextIds.has(pkt.contextId)) {
      this.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: pkt.contextId,
        timestampMs: Date.now(),
        name: "llm.delta_ignored_after_interrupt",
        value: String(pkt.text.length),
      });
      return;
    }

    this.emit("agent_text_delta", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
      delta: pkt.text,
    });
    this.debugPush({
      component: "llm",
      type: "delta",
      data: { context_id: pkt.contextId, text: pkt.text },
      timestampMs: pkt.timestampMs,
    });

    this.bufferTtsText(pkt.contextId, pkt.text);
  }

  private handleLlmDone(pkt: LlmResponseDonePacket): void {
    if (this.interruptedGenerationContextIds.has(pkt.contextId)) {
      this.ttsTextBuffers.delete(pkt.contextId);
      this.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: pkt.contextId,
        timestampMs: Date.now(),
        name: "llm.done_ignored_after_interrupt",
        value: "1",
      });
      return;
    }

    const spokenText = this.flushTtsText(pkt.contextId);
    this.emit("agent_finished", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
    });
    this.debugPush({
      component: "llm",
      type: "done",
      data: { context_id: pkt.contextId },
      timestampMs: pkt.timestampMs,
    });

    // Start idle timeout after agent finishes
    this.bus.push(Route.Main, {
      kind: "behavior.idle_timeout_start",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
    } as StartIdleTimeoutPacket);

    this.bus.push(Route.Main, {
      kind: "tts.done",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      text: spokenText,
    } as TextToSpeechDonePacket);
  }

  private bufferTtsText(contextId: string, text: string): void {
    const buffer = this.ttsTextBuffers.get(contextId) ?? { pending: "", emitted: "" };
    buffer.pending += text;
    const complete = takeCompleteVoiceText(buffer.pending);
    if (complete.text) {
      this.bus.push(Route.Main, {
        kind: "tts.text",
        contextId,
        timestampMs: Date.now(),
        text: complete.text,
      } as TextToSpeechTextPacket);
      buffer.emitted = appendVoiceText(buffer.emitted, complete.text);
    }
    buffer.pending = complete.remaining;
    this.ttsTextBuffers.set(contextId, buffer);
  }

  private flushTtsText(contextId: string): string {
    const buffer = this.ttsTextBuffers.get(contextId);
    if (!buffer) return "";
    const tail = buffer.pending.trim();
    if (tail) {
      this.bus.push(Route.Main, {
        kind: "tts.text",
        contextId,
        timestampMs: Date.now(),
        text: tail,
      } as TextToSpeechTextPacket);
      buffer.emitted = appendVoiceText(buffer.emitted, tail);
      buffer.pending = "";
      this.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId,
        timestampMs: Date.now(),
        name: isCompleteVoiceText(tail) ? "tts.final_text_flushed" : "tts.final_tail_flushed",
        value: tail,
      });
    }
    this.ttsTextBuffers.delete(contextId);
    return buffer.emitted.trim();
  }

  private handleLlmToolCall(pkt: LlmToolCallPacket): void {
    this.emit("agent_tool_call", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
      id: pkt.toolId,
      name: pkt.toolName,
      args: pkt.toolArgs,
    });
    this.debugPush({
      component: "tool",
      type: "call_started",
      data: {
        context_id: pkt.contextId,
        tool_id: pkt.toolId,
        tool_name: pkt.toolName,
      },
      timestampMs: pkt.timestampMs,
    });
  }

  private handleLlmToolResult(pkt: LlmToolResultPacket): void {
    this.emit("agent_tool_result", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
      id: pkt.toolId,
      result: pkt.result,
      durationMs: 0,
    });
    this.debugPush({
      component: "tool",
      type: "call_completed",
      data: {
        context_id: pkt.contextId,
        tool_id: pkt.toolId,
        tool_name: pkt.toolName,
      },
      timestampMs: pkt.timestampMs,
    });
  }

  private handleTtsAudio(pkt: TextToSpeechAudioPacket): void {
    if (this.interruptedGenerationContextIds.has(pkt.contextId)) {
      this.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: pkt.contextId,
        timestampMs: Date.now(),
        name: "tts.audio_ignored_after_interrupt",
        value: String(pkt.audio.byteLength),
      });
      return;
    }

    if (!this.firstTtsAudioFired.has(pkt.contextId)) {
      this.firstTtsAudioFired.add(pkt.contextId);
      if (this.vaqiMissedResponseContextId === pkt.contextId) {
        this.clearVaqiMissedResponseTimer();
      }
      const userStoppedMs = this.turnUserStoppedAtMs.get(pkt.contextId);
      if (userStoppedMs !== undefined) {
        this.bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId: pkt.contextId,
          timestampMs: Date.now(),
          name: "vaqi.latency_ms",
          value: String(pkt.timestampMs - userStoppedMs),
        });
        this.turnUserStoppedAtMs.delete(pkt.contextId);
      }
    }

    this.activeTtsContextIds.add(pkt.contextId);

    // Extend idle timeout by audio duration to prevent timeout during playback.
    const sampleRateHz = requireTtsAudioSampleRate(pkt.sampleRateHz);
    const audioDurationMs = estimatePcm16Duration(pkt.audio, sampleRateHz);
    this.idleTimeout.extend(audioDurationMs);

    this.debugPush({
      component: "tts",
      type: "audio",
      data: {
        context_id: pkt.contextId,
        bytes: String(pkt.audio.length),
      },
      timestampMs: pkt.timestampMs,
    });

    this.bus.push(Route.Main, {
      kind: "record.assistant_audio",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      audio: pkt.audio,
      sampleRateHz,
      truncate: false,
    } as RecordAssistantAudioPacket);
  }

  private handleTtsEnd(pkt: TextToSpeechEndPacket): void {
    this.activeTtsContextIds.delete(pkt.contextId);
    this.debugPush({
      component: "tts",
      type: "end",
      data: {},
      timestampMs: Date.now(),
    });
  }

  private handleInterruptDetected(pkt: InterruptionDetectedPacket): void {
    this.interruptedGenerationContextIds.add(pkt.contextId);
    this.ttsTextBuffers.delete(pkt.contextId);
    this.activeTtsContextIds.delete(pkt.contextId);
    this.debugPush({
      component: "turn",
      type: "interrupt_detected",
      data: {
        context_id: pkt.contextId,
        source: pkt.source,
      },
      timestampMs: pkt.timestampMs,
    });

    // Stop idle timeout
    this.bus.push(Route.Critical, {
      kind: "behavior.idle_timeout_stop",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      resetCount: true,
    } as StopIdleTimeoutPacket);

    this.bus.push(Route.Critical, {
      kind: "record.assistant_audio",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      audio: new Uint8Array(0),
      truncate: true,
    } as RecordAssistantAudioPacket);

    // Interrupt TTS
    const interruptTts: InterruptTtsPacket = {
      kind: "interrupt.tts",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
    };
    this.bus.push(Route.Critical, interruptTts);

    // Interrupt LLM
    const interruptLlm: InterruptLlmPacket = {
      kind: "interrupt.llm",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
    };
    this.bus.push(Route.Critical, interruptLlm);
  }

  private handleComponentError(pkt: VoiceErrorPacket): void {
    this.emit("error", {
      tsMs: pkt.timestampMs,
      stage: `${pkt.component}.error`,
      category: pkt.category,
      message: pkt.cause.message,
    });

    this.debugPush({
      component: pkt.component,
      type: "error",
      data: {
        category: pkt.category,
        message: pkt.cause.message,
        recoverable: String(pkt.isRecoverable),
      },
      timestampMs: pkt.timestampMs,
    });

    if (!isRecoverable(pkt.category)) {
      // Fatal error — close session
      void this.close().catch(() => {
        // Best effort
      });
    }
    // Recoverable errors are handled by individual component retry logic
  }

  private handleInitFailed(pkt: InitializationFailedPacket): void {
    this.emit("error", {
      tsMs: pkt.timestampMs,
      stage: `init.${pkt.stage}`,
      category: ErrorCategory.InternalFault,
      message: `Initialization failed: ${pkt.stage}/${pkt.component} — ${pkt.cause.message}`,
    });
  }

  private handleInjectMessage(pkt: InjectMessagePacket): void {
    // Inject as synthetic LLM output — goes through normal TTS path
    this.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      text: pkt.text,
    } as LlmDeltaPacket);
    this.bus.push(Route.Main, {
      kind: "llm.done",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      text: pkt.text,
    } as LlmResponseDonePacket);
  }

  private handleDisconnect(pkt: DisconnectRequestedPacket): void {
    this.emit("closed", { tsMs: pkt.timestampMs, reason: pkt.reason });
    this.debugPush({
      component: "session",
      type: "disconnect_requested",
      data: { reason: pkt.reason },
      timestampMs: pkt.timestampMs,
    });
    void this.close().catch(() => {
      // Best effort
    });
  }

  // =========================================================================
  // Init Chain
  // =========================================================================

  private buildInitChain(): void {
    const steps: InitStep[] = [];

    for (const [name, plugin] of this.plugins) {
      steps.push({
        name,
        stage: pluginStage(name),
        run: () => {
          return plugin.initialize(this.bus, this.config.plugins[name] ?? {});
        },
        cleanup: () => plugin.close(),
      });
    }

    const orderedPluginSteps = steps.sort(
      (a, b) => stageOrder(a.stage) - stageOrder(b.stage),
    );
    this.modeSwitcher.register({
      textToAudioSteps: orderedPluginSteps,
      audioToTextCleanups: [...orderedPluginSteps]
        .reverse()
        .filter((step) => isAudioStage(step.stage))
        .map((step) => async () => {
          await step.cleanup?.();
        }),
    });

    // Behavior is always last (idle timeout, max session)
    orderedPluginSteps.push({
      name: "idle_timeout",
      stage: InitStage.Behavior,
      run: async () => {
        this.idleTimeout.start();
      },
      cleanup: async () => {
        this.idleTimeout.dispose();
      },
    });

    this.initSteps = orderedPluginSteps;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private emitDebug(
    component: string,
    type: string,
    data: Record<string, string>,
  ): void {
    this.debugPush({
      component,
      type,
      data,
      timestampMs: Date.now(),
    });
  }

  private scheduleSttForceFinalize(contextId: string): void {
    if (this._state !== SessionState.Ready) return;
    if (this.sttForceFinalizeTimeoutMs <= 0) return;

    this.pendingSttContextId = contextId;
    this.clearSttForceFinalizeTimer(false);
    this.sttForceFinalizeTimer = setTimeout(() => {
      this.sttForceFinalizeTimer = null;
      const plugin = this.findForceFinalizableSttPlugin();
      plugin?.forceFinalize(contextId);
    }, this.sttForceFinalizeTimeoutMs);
  }

  private clearSttForceFinalizeTimer(clearContext = true): void {
    if (this.sttForceFinalizeTimer) {
      clearTimeout(this.sttForceFinalizeTimer);
      this.sttForceFinalizeTimer = null;
    }
    if (clearContext) {
      this.pendingSttContextId = "";
    }
  }

  private startVaqiMissedResponseTimer(contextId: string, startMs: number): void {
    this.clearVaqiMissedResponseTimer();
    this.vaqiMissedResponseContextId = contextId;
    this.vaqiMissedResponseStartMs = startMs;
    this.vaqiMissedResponseTimer = setTimeout(() => {
      this.vaqiMissedResponseTimer = null;
      const cid = this.vaqiMissedResponseContextId;
      const elapsedMs = Date.now() - this.vaqiMissedResponseStartMs;
      this.vaqiMissedResponseContextId = "";
      this.vaqiMissedResponseStartMs = 0;
      this.turnUserStoppedAtMs.delete(cid);
      this.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: cid,
        timestampMs: Date.now(),
        name: "vaqi.missed_response",
        value: String(elapsedMs),
      });
    }, this.vaqiMissedResponseMs);
  }

  private clearVaqiMissedResponseTimer(): void {
    if (this.vaqiMissedResponseTimer) {
      clearTimeout(this.vaqiMissedResponseTimer);
      this.vaqiMissedResponseTimer = null;
    }
    this.vaqiMissedResponseContextId = "";
    this.vaqiMissedResponseStartMs = 0;
  }

  private findForceFinalizableSttPlugin(): ForceFinalizableSttPlugin | null {
    for (const name of ["stt", "deepgram"]) {
      const plugin = this.plugins.get(name);
      if (isForceFinalizableSttPlugin(plugin)) {
        return plugin;
      }
    }

    for (const plugin of this.plugins.values()) {
      if (isForceFinalizableSttPlugin(plugin)) {
        return plugin;
      }
    }

    return null;
  }

  private latestActiveTtsContextId(): string {
    let latest = "";
    for (const contextId of this.activeTtsContextIds) {
      latest = contextId;
    }
    return latest;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function pluginStage(name: string): InitStage {
  switch (name) {
    case "stt":
    case "deepgram":
      return InitStage.STT;
    case "tts":
    case "cartesia":
    case "elevenlabs":
      return InitStage.TTS;
    case "vad":
    case "silero":
      return InitStage.VAD;
    case "eos":
    case "pipecat":
      return InitStage.EOS;
    case "denoiser":
    case "rnnoise":
      return InitStage.Denoiser;
    case "bridge":
    case "aisdk":
      return InitStage.Assistant;
    case "recorder":
      return InitStage.Recorder;
    case "auth":
      return InitStage.Auth;
    default:
      return InitStage.Assistant;
  }
}

function stageOrder(stage: InitStage): number {
  switch (stage) {
    case InitStage.Assistant:
      return 10;
    case InitStage.Conversation:
      return 20;
    case InitStage.Recorder:
      return 30;
    case InitStage.Normalizer:
      return 40;
    case InitStage.Auth:
      return 50;
    case InitStage.STT:
      return 60;
    case InitStage.TTS:
      return 70;
    case InitStage.VAD:
      return 80;
    case InitStage.EOS:
      return 90;
    case InitStage.Denoiser:
      return 100;
    case InitStage.Behavior:
      return 110;
    case InitStage.Telemetry:
      return 120;
  }
}

function isAudioStage(stage: InitStage): boolean {
  return (
    stage === InitStage.STT ||
    stage === InitStage.TTS ||
    stage === InitStage.VAD ||
    stage === InitStage.EOS ||
    stage === InitStage.Denoiser
  );
}

function estimatePcm16Duration(
  audio: Uint8Array,
  sampleRate: number,
): number {
  // Each sample is 2 bytes (16-bit), mono = 1 channel
  const samples = audio.length / 2;
  return (samples / sampleRate) * 1000;
}

function requireTtsAudioSampleRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("tts.audio sampleRateHz must be a positive integer");
  }
  return value;
}

function languageFromTranscripts(
  transcripts: readonly SttResultPacket[],
): string {
  for (const transcript of transcripts) {
    if (transcript.language) {
      return transcript.language;
    }
  }
  return "";
}

function takeCompleteVoiceText(text: string): { text: string; remaining: string } {
  const segments = segmentSentences(text);
  let emitted = "";
  let remaining = "";
  for (const segment of segments) {
    if (remaining) {
      remaining += segment;
      continue;
    }
    if (isCompleteVoiceText(segment)) {
      emitted += segment;
    } else {
      remaining = segment;
    }
  }
  return { text: emitted.trimEnd(), remaining };
}

function isCompleteVoiceText(text: string): boolean {
  const trimmed = text.trim();
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const char = trimmed[index]!;
    if (isClosingPunctuation(char)) continue;
    return isTerminalPunctuation(char);
  }
  return false;
}

function isClosingPunctuation(char: string): boolean {
  return char === ")" || char === "]" || char === "}" || char === "\"" || char === "'" || char === "”" || char === "’";
}

function isTerminalPunctuation(char: string): boolean {
  return char === "." ||
    char === "!" ||
    char === "?" ||
    char === "。" ||
    char === "！" ||
    char === "？" ||
    char === "؟" ||
    char === "।" ||
    char === "॥";
}

function segmentSentences(text: string): string[] {
  const segmenter = createSentenceSegmenter();
  if (segmenter) {
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }

  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!isTerminalPunctuation(text[index]!)) continue;
    let end = index + 1;
    while (end < text.length && isClosingPunctuation(text[end]!)) end += 1;
    if (end < text.length && !/\s/.test(text[end]!)) continue;
    segments.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) segments.push(text.slice(start));
  return segments;
}

function appendVoiceText(existing: string, next: string): string {
  const normalizedNext = next.trim();
  if (!existing) return normalizedNext;
  if (!normalizedNext) return existing;
  if (/\s$/.test(existing) || /^\s/.test(next)) return `${existing}${normalizedNext}`;
  return `${existing} ${normalizedNext}`;
}

function createSentenceSegmenter(): { segment(text: string): Iterable<SentenceSegment> } | null {
  const Segmenter = (Intl as unknown as { Segmenter?: new (
    locale?: string | string[],
    options?: { granularity: "sentence" },
  ) => { segment(text: string): Iterable<SentenceSegment> } }).Segmenter;
  if (!Segmenter) return null;
  try {
    return new Segmenter(undefined, { granularity: "sentence" });
  } catch {
    return null;
  }
}

interface ForceFinalizableSttPlugin extends VoicePlugin {
  forceFinalize(contextId?: string): void;
}

function isForceFinalizableSttPlugin(
  plugin: VoicePlugin | undefined,
): plugin is ForceFinalizableSttPlugin {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    "forceFinalize" in plugin &&
    typeof plugin.forceFinalize === "function"
  );
}
