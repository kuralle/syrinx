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
  VoiceErrorPacket,
  UserAudioReceivedPacket,
  UserTextReceivedPacket,
  InterruptionDetectedPacket,
  LlmDeltaPacket,
  LlmResponseDonePacket,
  LlmToolCallPacket,
  LlmToolResultPacket,
  TextToSpeechAudioPacket,
  TextToSpeechEndPacket,
  TextToSpeechPlayoutProgressPacket,
  SpeechToTextAudioPacket,
  SttResultPacket,
  SttInterimPacket,
  VadAudioPacket,
  VadSpeechStartedPacket,
  VadSpeechActivityPacket,
  VadSpeechEndedPacket,
  EndOfSpeechPacket,
  InterimEndOfSpeechPacket,
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
import { LatencyFillerController } from "./latency-filler.js";
import { PrimarySpeakerGate } from "./primary-speaker-gate.js";
import { takeCompleteVoiceText, isCompleteVoiceText, appendVoiceText } from "./voice-text.js";
import { TtsPlayoutClock } from "./tts-playout-clock.js";
import * as make from "./packet-factories.js";
import { pluginStage, stageOrder, isAudioStage } from "./init-stage-order.js";

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
   * When true (default), barge-in requires sustained speech from the enrolled
   * primary speaker (first user turn fingerprint) in addition to G1's time gate.
   * Non-primary / echo speech emits `interrupt.suppressed_non_primary`. When no
   * profile is enrolled yet, falls back to G1-only behavior.
   */
  primarySpeakerBargeInEnabled?: boolean;
  /**
   * When true, emit a short discourse connective via TTS at endpoint (before LLM
   * TTFB) and splice the real response in when it arrives. Off by default.
   */
  latencyFillerEnabled?: boolean;
  /**
   * Maximum ms after a user turn ends to wait for first assistant audio before
   * emitting a vaqi.missed_response metric (VAQI-M). 0 disables the check.
   * Default: 4000.
   */
  vaqiMissedResponseMs?: number;
  /**
   * Max ms of silence from the TTS provider AFTER it has begun producing audio for a
   * turn before the output is treated as a stalled provider. Guards against a TTS
   * provider that goes silent mid-utterance without `tts.end` or an error (dead air).
   * Armed only after the first `tts.audio`, so first-audio latency (which can be many
   * seconds on some providers, e.g. Gemini) is never watchdogged. On breach, a
   * recoverable `tts.error` (NetworkTimeout) is emitted so the turn fails visibly
   * instead of hanging. 0 disables. Default: 15000.
   */
  ttsStallMs?: number;
  /**
   * Spoken fallback when the reasoning (LLM) layer fails a turn with a recoverable
   * error. "Never fail silently" (Deepgram guide Ch3): rather than ending the turn in
   * unexplained silence, the agent speaks this line via the normal TTS path (which is
   * unaffected by an LLM failure). Empty string disables. Default: a brief apology.
   * (TTS/STT-failure fallback needs canned audio / a clarification prompt — out of scope.)
   */
  errorFallbackText?: string;
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

/** Suffix marking a context created to speak an error fallback, so it never recurses. */
const FALLBACK_CONTEXT_SUFFIX = ":error-fallback";

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
  // Tracks which contexts are still playing out their TTS audio; turn-taking and
  // the stall watchdog key on this. Pure state — see TtsPlayoutClock.
  private readonly ttsPlayout = new TtsPlayoutClock();
  private interruptedGenerationContextIds = new Set<string>();
  private ttsTextBuffers = new Map<string, TtsTextBuffer>();
  private readonly minInterruptionMs: number;
  private readonly primarySpeakerGate: PrimarySpeakerGate;
  private readonly latencyFiller: LatencyFillerController;
  private firstLlmDeltaReceived = new Set<string>();
  private pendingInterruption: {
    userContextId: string;
    interruptedContextId: string;
    firstSpeechMs: number;
  } | null = null;
  private pendingInterruptionAwaitingAudio = false;
  private readonly vaqiMissedResponseMs: number;
  private turnUserStoppedAtMs = new Map<string, number>();
  private firstTtsAudioFired = new Set<string>();
  private vaqiMissedResponseTimer: ReturnType<typeof setTimeout> | null = null;
  private vaqiMissedResponseContextId = "";
  private vaqiMissedResponseStartMs = 0;
  private readonly ttsStallMs: number;
  private ttsStallTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsStallContextId = "";
  private readonly errorFallbackText: string;
  private fallbackInjectedContexts = new Set<string>();

  constructor(config: VoiceAgentSessionConfig) {
    this.config = config;
    this.sttForceFinalizeTimeoutMs = config.sttForceFinalizeTimeoutMs ?? 7000;
    this.minInterruptionMs = config.minInterruptionMs ?? 280;
    this.primarySpeakerGate = new PrimarySpeakerGate({
      enabled: config.primarySpeakerBargeInEnabled !== false,
    });
    this.latencyFiller = new LatencyFillerController({
      enabled: config.latencyFillerEnabled === true,
    });
    this.vaqiMissedResponseMs = config.vaqiMissedResponseMs ?? 4000;
    this.ttsStallMs = config.ttsStallMs ?? 15000;
    this.errorFallbackText = config.errorFallbackText ?? "Sorry, I'm having trouble right now. Could you try again?";

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
    this.clearTtsStallTimer();
    this.ttsPlayout.clear();
    this.turnUserStoppedAtMs.clear();
    this.firstTtsAudioFired.clear();
    this.fallbackInjectedContexts.clear();
    this.ttsTextBuffers.clear();
    this.interruptedGenerationContextIds.clear();
    this.firstLlmDeltaReceived.clear();

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
    this.bus.push(Route.Main, make.modeSwitchRequested(this.currentTurnId, Date.now(), mode));
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
    this.bus.on("vad.audio", this.handleVadAudioForSpeakerGate.bind(this));

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
    this.bus.on("tts.playout_progress", this.handleTtsPlayoutProgress.bind(this));

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
    this.bus.on<StartIdleTimeoutPacket>("behavior.idle_timeout_start", (pkt) => {
      this.idleTimeout.handleStart(pkt);
    });
    this.bus.on<StopIdleTimeoutPacket>("behavior.idle_timeout_stop", (pkt) => {
      this.idleTimeout.handleStop(pkt);
    });

    // Injected messages — push through LLM path for natural TTS
    this.bus.on("inject.message", this.handleInjectMessage.bind(this));

    // Disconnect
    this.bus.on("session.disconnect", this.handleDisconnect.bind(this));

    // Mode switching
    this.bus.on<ModeSwitchRequestedPacket>("mode.switch_requested", async (pkt) => {
      await this.modeSwitcher.handleSwitchRequested(pkt);
    });
  }

  // =========================================================================
  // Handler Implementations
  // =========================================================================

  private handleUserAudio(pkt: UserAudioReceivedPacket): void {
    if (!this.latestActiveTtsContextId()) {
      this.primarySpeakerGate.enrollUserTurnChunk(pkt.audio);
    }
    this.bus.push(
      Route.Main,
      make.recordUserAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
      make.vadAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
      make.sttAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
      make.eosAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
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
    this.bus.push(Route.Main, make.eosTurnComplete(pkt.contextId, pkt.timestampMs, pkt.text, []));
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

  private handleVadAudioForSpeakerGate(pkt: VadAudioPacket): void {
    const pending = this.pendingInterruption;
    if (pending && pending.userContextId === pkt.contextId) {
      this.primarySpeakerGate.observeBargeInChunk(pkt.audio);
      if (this.pendingInterruptionAwaitingAudio) {
        this.pendingInterruptionAwaitingAudio = false;
        this.tryCommitPendingInterruption(pkt.timestampMs);
      }
      return;
    }

    if (!this.latestActiveTtsContextId()) {
      this.primarySpeakerGate.enrollUserTurnChunk(pkt.audio);
    }
  }

  private handleVadSpeechStarted(pkt: VadSpeechStartedPacket): void {
    if (this.latencyFiller.isFillerOnly(this.currentTurnId)) {
      this.cancelLatencyFillerTurn(this.currentTurnId, pkt.timestampMs);
    }

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
      if (this.shouldDeferImmediateBargeInForSpeakerGate()) {
        this.beginPendingInterruption(pkt, interruptedContextId);
        this.pendingInterruptionAwaitingAudio = true;
        return;
      }
      this.bus.push(Route.Background, make.metric(interruptedContextId, "vaqi.interruption", "1"));
      this.emitInterruptDetected(interruptedContextId);
      return;
    }

    // Defer the cut until the user's speech is sustained past minInterruptionMs.
    // VAD emits `vad.speech_activity` per speech frame (never during silence), so a
    // transient noise spike / click / very short blip produces only a few activity
    // frames and then `vad.speech_ended` — which cancels this pending interruption
    // instead of cutting off the agent. Sustained speech keeps emitting activity and
    // crosses the threshold in handleVadSpeechActivity.
    this.beginPendingInterruption(pkt, interruptedContextId);
  }

  private beginPendingInterruption(
    pkt: VadSpeechStartedPacket,
    interruptedContextId: string,
  ): void {
    this.primarySpeakerGate.beginBargeInWindow();
    this.pendingInterruptionAwaitingAudio = false;
    this.pendingInterruption = {
      userContextId: pkt.contextId,
      interruptedContextId,
      firstSpeechMs: pkt.timestampMs,
    };
  }

  private shouldDeferImmediateBargeInForSpeakerGate(): boolean {
    return (
      this.primarySpeakerGate.isEnabled() &&
      this.primarySpeakerGate.hasProfile()
    );
  }

  private handleVadSpeechActivity(pkt: VadSpeechActivityPacket): void {
    const pending = this.pendingInterruption;
    if (!pending || pending.userContextId !== pkt.contextId) return;
    if (pkt.timestampMs - pending.firstSpeechMs < this.minInterruptionMs) return;
    this.tryCommitPendingInterruption(pkt.timestampMs);
  }

  private tryCommitPendingInterruption(nowMs: number): void {
    const pending = this.pendingInterruption;
    if (!pending) return;
    if (nowMs - pending.firstSpeechMs < this.minInterruptionMs) return;

    if (
      this.primarySpeakerGate.isEnabled() &&
      this.primarySpeakerGate.hasProfile() &&
      !this.primarySpeakerGate.shouldCommitBargeIn()
    ) {
      this.suppressPendingInterruption(
        pending,
        "interrupt.suppressed_non_primary",
        nowMs - pending.firstSpeechMs,
      );
      return;
    }

    const sustainedMs = nowMs - pending.firstSpeechMs;
    this.pendingInterruption = null;
    this.pendingInterruptionAwaitingAudio = false;
    this.primarySpeakerGate.resetBargeInWindow();

    if (!this.ttsPlayout.isActive(pending.interruptedContextId)) {
      this.bus.push(
        Route.Background,
        make.metric(pending.interruptedContextId, "interrupt.gate_resolved_after_tts_end", String(sustainedMs)),
      );
      return;
    }

    this.bus.push(
      Route.Background,
      make.metric(pending.interruptedContextId, "interrupt.committed_after_ms", String(sustainedMs)),
    );
    this.bus.push(Route.Background, make.metric(pending.interruptedContextId, "vaqi.interruption", "1"));
    this.bus.push(
      Route.Background,
      make.metric(pending.interruptedContextId, "interrupt.latency_ms", String(sustainedMs)),
    );
    this.emitInterruptDetected(pending.interruptedContextId);
  }

  private suppressPendingInterruption(
    pending: NonNullable<typeof this.pendingInterruption>,
    metricName: string,
    durationMs: number,
  ): void {
    this.pendingInterruption = null;
    this.pendingInterruptionAwaitingAudio = false;
    this.primarySpeakerGate.resetBargeInWindow();
    this.bus.push(Route.Background, make.metric(pending.interruptedContextId, metricName, String(durationMs)));
  }

  private emitInterruptDetected(interruptedContextId: string): void {
    this.bus.push(Route.Critical, make.interruptDetected(interruptedContextId, Date.now(), "vad"));
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
      const durationMs = pkt.timestampMs - pending.firstSpeechMs;
      if (durationMs >= this.minInterruptionMs) {
        if (
          this.primarySpeakerGate.isEnabled() &&
          this.primarySpeakerGate.hasProfile() &&
          !this.primarySpeakerGate.shouldCommitBargeIn()
        ) {
          this.suppressPendingInterruption(
            pending,
            "interrupt.suppressed_non_primary",
            durationMs,
          );
        } else {
          this.tryCommitPendingInterruption(pkt.timestampMs);
        }
      } else {
        this.suppressPendingInterruption(
          pending,
          "interrupt.suppressed_short_speech",
          durationMs,
        );
      }
    } else if (!this.latestActiveTtsContextId()) {
      this.primarySpeakerGate.lockProfileFromFirstTurn();
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
    this.bus.push(Route.Main, make.stopIdleTimeout(pkt.contextId, Date.now(), false));

    const fillerText = this.latencyFiller.start(pkt.contextId, pkt.text, pkt.timestampMs);
    if (fillerText) {
      this.bus.push(Route.Main, make.ttsText(pkt.contextId, Date.now(), fillerText));
      this.bus.push(Route.Background, make.metric(pkt.contextId, "filler.started", fillerText));
    }

    this.bus.push(
      Route.Main,
      make.userInput(pkt.contextId, Date.now(), pkt.text, languageFromTranscripts(pkt.transcripts)),
    );
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
      this.bus.push(
        Route.Background,
        make.metric(pkt.contextId, "llm.delta_ignored_after_interrupt", String(pkt.text.length)),
      );
      return;
    }

    let deltaText = pkt.text;
    if (!this.firstLlmDeltaReceived.has(pkt.contextId)) {
      this.firstLlmDeltaReceived.add(pkt.contextId);
      if (this.latencyFiller.isActive(pkt.contextId)) {
        deltaText = this.latencyFiller.spliceLlmDelta(pkt.contextId, deltaText);
        this.bus.push(Route.Background, make.metric(pkt.contextId, "filler.spliced", "1"));
      }
    }

    this.emit("agent_text_delta", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
      delta: deltaText,
    });
    this.debugPush({
      component: "llm",
      type: "delta",
      data: { context_id: pkt.contextId, text: deltaText },
      timestampMs: pkt.timestampMs,
    });

    this.bufferTtsText(pkt.contextId, deltaText);
  }

  private handleLlmDone(pkt: LlmResponseDonePacket): void {
    if (this.interruptedGenerationContextIds.has(pkt.contextId)) {
      this.ttsTextBuffers.delete(pkt.contextId);
      this.bus.push(Route.Background, make.metric(pkt.contextId, "llm.done_ignored_after_interrupt", "1"));
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
    this.bus.push(Route.Main, make.startIdleTimeout(pkt.contextId, Date.now()));

    this.bus.push(Route.Main, make.ttsDone(pkt.contextId, Date.now(), spokenText));
  }

  private bufferTtsText(contextId: string, text: string): void {
    const buffer = this.ttsTextBuffers.get(contextId) ?? { pending: "", emitted: "" };
    buffer.pending += text;
    const complete = takeCompleteVoiceText(buffer.pending);
    if (complete.text) {
      this.bus.push(Route.Main, make.ttsText(contextId, Date.now(), complete.text));
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
      this.bus.push(Route.Main, make.ttsText(contextId, Date.now(), tail));
      buffer.emitted = appendVoiceText(buffer.emitted, tail);
      buffer.pending = "";
      this.bus.push(
        Route.Background,
        make.metric(contextId, isCompleteVoiceText(tail) ? "tts.final_text_flushed" : "tts.final_tail_flushed", tail),
      );
    }
    this.ttsTextBuffers.delete(contextId);
    this.latencyFiller.clear(contextId);
    this.firstLlmDeltaReceived.delete(contextId);
    return buffer.emitted.trim();
  }

  private cancelLatencyFillerTurn(contextId: string, timestampMs: number): void {
    const cancelled = this.latencyFiller.cancel(contextId);
    if (!cancelled) return;
    this.bus.push(Route.Background, make.metric(contextId, "filler.cancelled", cancelled.text, timestampMs));
    this.emitInterruptDetected(contextId);
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
      this.bus.push(
        Route.Background,
        make.metric(pkt.contextId, "tts.audio_ignored_after_interrupt", String(pkt.audio.byteLength)),
      );
      return;
    }

    if (!this.firstTtsAudioFired.has(pkt.contextId)) {
      this.firstTtsAudioFired.add(pkt.contextId);
      if (this.vaqiMissedResponseContextId === pkt.contextId) {
        this.clearVaqiMissedResponseTimer();
      }
      const userStoppedMs = this.turnUserStoppedAtMs.get(pkt.contextId);
      if (userStoppedMs !== undefined) {
        this.bus.push(
          Route.Background,
          make.metric(pkt.contextId, "vaqi.latency_ms", String(pkt.timestampMs - userStoppedMs)),
        );
        this.turnUserStoppedAtMs.delete(pkt.contextId);
      }
    }

    this.primarySpeakerGate.observeAssistantPlayout(pkt.audio);
    // Audio just arrived — (re)arm the stall watchdog for this turn's TTS output.
    this.armTtsStallTimer(pkt.contextId);

    // Extend idle timeout by audio duration to prevent timeout during playback.
    const sampleRateHz = requireTtsAudioSampleRate(pkt.sampleRateHz);
    const audioDurationMs = estimatePcm16Duration(pkt.audio, sampleRateHz);
    this.idleTimeout.extend(audioDurationMs);

    // Mark active and advance this context's playout cursor by the chunk's
    // realtime duration.
    this.ttsPlayout.noteAudio(pkt.contextId, audioDurationMs, Date.now());

    this.debugPush({
      component: "tts",
      type: "audio",
      data: {
        context_id: pkt.contextId,
        bytes: String(pkt.audio.length),
      },
      timestampMs: pkt.timestampMs,
    });

    this.bus.push(Route.Main, make.recordAssistantAudio(pkt.contextId, Date.now(), pkt.audio, sampleRateHz));
  }

  private handleTtsEnd(pkt: TextToSpeechEndPacket): void {
    // Generation finished, but the streamed audio is still playing out. Keep the
    // context interruptible until its playout estimate elapses, then release it.
    this.ttsPlayout.scheduleRelease(pkt.contextId, Date.now());
    this.clearTtsStallTimerFor(pkt.contextId);
    this.debugPush({
      component: "tts",
      type: "end",
      data: {},
      timestampMs: Date.now(),
    });
  }

  private handleTtsPlayoutProgress(pkt: TextToSpeechPlayoutProgressPacket): void {
    this.ttsPlayout.noteProgress(pkt.contextId, pkt.complete);
  }

  private handleInterruptDetected(pkt: InterruptionDetectedPacket): void {
    this.interruptedGenerationContextIds.add(pkt.contextId);
    this.latencyFiller.cancel(pkt.contextId);
    this.firstLlmDeltaReceived.delete(pkt.contextId);
    this.ttsTextBuffers.delete(pkt.contextId);
    this.ttsPlayout.release(pkt.contextId);
    this.clearTtsStallTimerFor(pkt.contextId);
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
    this.bus.push(Route.Critical, make.stopIdleTimeout(pkt.contextId, Date.now(), true));

    this.bus.push(Route.Critical, make.recordAssistantTruncate(pkt.contextId, Date.now()));

    // Interrupt TTS, then LLM
    this.bus.push(Route.Critical, make.interruptTts(pkt.contextId, Date.now()));
    this.bus.push(Route.Critical, make.interruptLlm(pkt.contextId, Date.now()));
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
      return;
    }
    // Recoverable errors are handled by individual component retry logic. But never
    // leave the caller in unexplained silence: if the reasoning layer failed the turn,
    // speak a graceful fallback (G4 — Deepgram guide "never fail silently").
    this.maybeSpeakErrorFallback(pkt);
  }

  private maybeSpeakErrorFallback(pkt: VoiceErrorPacket): void {
    if (!this.errorFallbackText) return;
    // Only the reasoning layer: a TTS/STT failure can't reliably use the same TTS path
    // for a fallback (that needs canned audio / a clarification prompt — out of scope).
    if (pkt.component !== "llm") return;
    const contextId = pkt.contextId;
    if (contextId.endsWith(FALLBACK_CONTEXT_SUFFIX)) return; // never fall back for a fallback
    if (this.fallbackInjectedContexts.has(contextId)) return; // at most once per turn
    this.fallbackInjectedContexts.add(contextId);
    this.bus.push(Route.Background, make.metric(contextId, "error.fallback_spoken", pkt.component));
    this.bus.push(
      Route.Main,
      make.injectMessage(`${contextId}${FALLBACK_CONTEXT_SUFFIX}`, Date.now(), this.errorFallbackText),
    );
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
    this.bus.push(Route.Main, make.llmDelta(pkt.contextId, Date.now(), pkt.text));
    this.bus.push(Route.Main, make.llmDone(pkt.contextId, Date.now(), pkt.text));
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
      this.bus.push(Route.Background, make.metric(cid, "vaqi.missed_response", String(elapsedMs)));
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

  // G3: TTS output stall watchdog. Armed/reset on each tts.audio; if the provider goes
  // silent (no further audio and no tts.end) for ttsStallMs after producing audio, the
  // turn is treated as a stalled provider and surfaced as a recoverable tts.error so it
  // fails visibly instead of hanging. Only arms after first audio, so first-audio latency
  // is never watchdogged.
  private armTtsStallTimer(contextId: string): void {
    if (this.ttsStallMs <= 0) return;
    this.clearTtsStallTimer();
    this.ttsStallContextId = contextId;
    this.ttsStallTimer = setTimeout(() => {
      this.ttsStallTimer = null;
      const cid = this.ttsStallContextId;
      this.ttsStallContextId = "";
      if (this.interruptedGenerationContextIds.has(cid)) return; // interrupted, not stalled
      if (!this.ttsPlayout.isActive(cid)) return; // already ended
      this.ttsPlayout.release(cid);
      this.bus.push(Route.Background, make.metric(cid, "tts.stall_detected", String(this.ttsStallMs)));
      this.bus.push(
        Route.Critical,
        make.ttsError(
          cid,
          Date.now(),
          new Error(`TTS output stalled: no audio or tts.end for ${String(this.ttsStallMs)}ms`),
          ErrorCategory.NetworkTimeout,
          true,
        ),
      );
    }, this.ttsStallMs);
  }

  private clearTtsStallTimer(): void {
    if (this.ttsStallTimer) {
      clearTimeout(this.ttsStallTimer);
      this.ttsStallTimer = null;
    }
    this.ttsStallContextId = "";
  }

  private clearTtsStallTimerFor(contextId: string): void {
    if (this.ttsStallContextId === contextId) this.clearTtsStallTimer();
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
    return this.ttsPlayout.latestActive();
  }
}

// =============================================================================
// Helpers
// =============================================================================

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
