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
import type { VoicePlugin, PluginConfig, EndpointingOwner } from "./plugin-contract.js";
import { IdleTimeoutManager, type IdleTimeoutConfig } from "./idle-timeout.js";
import { ModeSwitcher } from "./mode-switcher.js";
import { createConversationEventStream, type ConversationEvent } from "./conversation-event.js";
import { isRecoverable } from "./error-handler.js";
import type {
  VoiceErrorPacket,
  UserAudioReceivedPacket,
  UserTextReceivedPacket,
  InterruptionDetectedPacket,
  DelegateQueryPacket,
  DelegateResultPacket,
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
import { TurnArbiter, isBackchannel } from "./turn-arbiter.js";
import * as make from "./packet-factories.js";
import { pluginStage, stageOrder, isAudioStage } from "./init-stage-order.js";
import {
  estimatePcm16Duration,
  languageFromTranscripts,
  requireTtsAudioSampleRate,
  VoiceSessionWatchdogs,
} from "./voice-agent-session-util.js";
import { noopMetricsExporter, type MetricsExporter } from "./observability.js";
import { ObservabilityObserver } from "./observability-observer.js";
import { TimerScheduler, type Scheduler } from "./scheduler.js";

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
   * Max ms of silence on inbound user audio while the session is Ready before a
   * recoverable transport warning is emitted. Continuous streams (telephony, open
   * mic) should set this; push-to-talk / headless sessions leave at 0 (disabled).
   * Default: 0.
   */
  inputCadenceTimeoutMs?: number;
  /**
   * Spoken fallback when the reasoning (LLM) layer fails a turn with a recoverable
   * error. "Never fail silently" (Deepgram guide Ch3): rather than ending the turn in
   * unexplained silence, the agent speaks this line via the normal TTS path (which is
   * unaffected by an LLM failure). Empty string disables. Default: a brief apology.
   * (TTS/STT-failure fallback needs canned audio / a clarification prompt — out of scope.)
   */
  errorFallbackText?: string;
  /**
   * G3 (RFC bimodel-delegate-seam): ms a tool call may stay pending before the
   * `tool_call_cue` session event fires its time-triggered `"delayed"` phase — the
   * "still working" cue clients render during a long reasoner wait (cf. Vapi's
   * `request-response-delayed` + `timingMilliseconds`). 0 disables the delayed
   * phase; started/complete/failed always fire. Default: 2000.
   */
  delayCueAfterMs?: number;
  /**
   * Which component owns turn boundary (EOS) for this session. Defaults to
   * provider STT ownership; Smart Turn sessions must opt in explicitly.
   */
  endpointingOwner?: "provider_stt" | "smart_turn" | "timer";
  readonly metricsExporter?: MetricsExporter;
  readonly scheduler?: Scheduler;
  readonly observability?: {
    readonly sessionId?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly region?: string;
  };
}

export interface VoiceAgentSessionEvents {
  user_started_speaking: (event: { tsMs: number; turnId: string }) => void;
  user_stopped_speaking: (event: { tsMs: number; turnId: string }) => void;
  user_input_partial: (event: { tsMs: number; turnId: string; text: string }) => void;
  user_input_final: (event: { tsMs: number; turnId: string; text: string; confidence: number }) => void;
  agent_text_delta: (event: { tsMs: number; turnId: string; delta: string }) => void;
  agent_tool_call: (event: { tsMs: number; turnId: string; id: string; name: string; args: Record<string, unknown> }) => void;
  agent_tool_result: (event: { tsMs: number; turnId: string; id: string; result: string; durationMs: number }) => void;
  delegate_query: (event: { tsMs: number; turnId: string; query: string; toolId?: string; toolName?: string }) => void;
  delegate_result: (event: { tsMs: number; turnId: string; query: string; answer: string; durationMs: number; grounded: boolean; toolId?: string; toolName?: string }) => void;
  /**
   * G3: typed preamble/filler lifecycle for a pending tool call (Vapi-shaped:
   * started / delayed / complete / failed). `delayed` is time-triggered by
   * `delayCueAfterMs` while the call is still pending; `failed` fires on an LLM/bridge
   * error, a barge-in, or a superseding turn while pending (R5). Transports surface
   * these as `tool_call_*` wire messages — the standard "thinking" cue.
   */
  tool_call_cue: (event: { tsMs: number; turnId: string; phase: "started" | "delayed" | "complete" | "failed"; toolId: string; toolName: string; afterMs?: number }) => void;
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

/** Scheduler key for a pending tool call's G3 delayed-cue timer. */
function toolCueTimerKey(contextId: string, toolId: string): string {
  return `tool_cue:${contextId}:${toolId}`;
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
  // Tracks which contexts are still playing out their TTS audio; turn-taking and
  // the stall watchdog key on this. Pure state — see TtsPlayoutClock.
  private readonly scheduler: Scheduler;
  private readonly ttsPlayout: TtsPlayoutClock;
  private interruptedGenerationContextIds = new Set<string>();
  // Turns whose generation is in-flight (eos.turn_complete emitted, not yet
  // finished/interrupted). Lets a client "stop" during the reasoner TTFT gap —
  // before any audio plays — still abort the turn (thinking-phase barge-in, B3).
  private generatingContextIds = new Set<string>();
  private ttsTextBuffers = new Map<string, TtsTextBuffer>();
  private readonly minInterruptionMs: number;
  private readonly primarySpeakerGate: PrimarySpeakerGate;
  private readonly turnArbiter!: TurnArbiter;
  private readonly latencyFiller: LatencyFillerController;
  private firstLlmDeltaReceived = new Set<string>();
  private readonly vaqiMissedResponseMs: number;
  private readonly ttsStallMs: number;
  private readonly inputCadenceTimeoutMs: number;
  private readonly watchdogs!: VoiceSessionWatchdogs;
  private readonly observabilityObserver: ObservabilityObserver;
  private turnUserStoppedAtMs = new Map<string, number>();
  private speakerEnrollmentContextId: string | null = null;
  private firstTtsAudioFired = new Set<string>();
  private readonly errorFallbackText: string;
  private fallbackInjectedContexts = new Set<string>();
  // G3: pending tool calls per context (toolId → toolName) driving the tool_call_cue lifecycle.
  private readonly delayCueAfterMs: number;
  private pendingToolCues = new Map<string, Map<string, string>>();
  private readonly endpointingOwner: "provider_stt" | "smart_turn" | "timer";
  private lastFinalizedContextId = "";

  constructor(config: VoiceAgentSessionConfig) {
    const owner = config.endpointingOwner;
    if (owner !== undefined && owner !== "provider_stt" && owner !== "smart_turn" && owner !== "timer") {
      throw new Error(`Unsupported endpointingOwner: ${owner}`);
    }
    this.endpointingOwner = owner ?? "provider_stt";
    this.config = config;
    this.scheduler = config.scheduler ?? new TimerScheduler();
    this.ttsPlayout = new TtsPlayoutClock(this.scheduler);
    this.sttForceFinalizeTimeoutMs = config.sttForceFinalizeTimeoutMs ?? 7000;
    this.minInterruptionMs = config.minInterruptionMs ?? 280;
    this.delayCueAfterMs = config.delayCueAfterMs ?? 2000;
    this.primarySpeakerGate = new PrimarySpeakerGate({
      enabled: config.primarySpeakerBargeInEnabled !== false,
    });
    this.latencyFiller = new LatencyFillerController({
      enabled: config.latencyFillerEnabled === true,
    });
    this.vaqiMissedResponseMs = config.vaqiMissedResponseMs ?? 4000;
    this.ttsStallMs = config.ttsStallMs ?? 15000;
    this.inputCadenceTimeoutMs = config.inputCadenceTimeoutMs ?? 0;
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

    this.turnArbiter = new TurnArbiter({
      bus: this.bus,
      primarySpeakerGate: this.primarySpeakerGate,
      ttsPlayout: this.ttsPlayout,
      minInterruptionMs: this.minInterruptionMs,
    });
    this.watchdogs = new VoiceSessionWatchdogs({
      bus: this.bus,
      plugins: this.plugins,
      ttsPlayout: this.ttsPlayout,
      sttForceFinalizeTimeoutMs: this.sttForceFinalizeTimeoutMs,
      vaqiMissedResponseMs: this.vaqiMissedResponseMs,
      ttsStallMs: this.ttsStallMs,
      inputCadenceTimeoutMs: this.inputCadenceTimeoutMs,
      getSessionState: () => this._state,
      isGenerationInterrupted: (contextId) => this.interruptedGenerationContextIds.has(contextId),
      onVaqiMissedResponseFired: (contextId) => {
        this.turnUserStoppedAtMs.delete(contextId);
      },
      scheduler: this.scheduler,
    });

    const obs = config.observability;
    this.observabilityObserver = new ObservabilityObserver({
      bus: this.bus,
      exporter: config.metricsExporter ?? noopMetricsExporter,
      sessionId: obs?.sessionId ?? "",
      dims: {
        provider: obs?.provider ?? "unknown",
        model: obs?.model ?? "unknown",
        region: obs?.region ?? "unknown",
      },
      getContextId: () => this.currentContextId,
    });

    // Idle timeout — starts after bus handlers are wired
    this.idleTimeout = new IdleTimeoutManager(this.bus, config.idleTimeout, this.scheduler);

    // Mode switcher
    this.modeSwitcher = new ModeSwitcher(this.bus);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  get state(): SessionState {
    return this._state;
  }

  get currentContextId(): string {
    return this.currentTurnId;
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
    this.watchdogs.dispose();
    this.observabilityObserver.dispose();
    this.ttsPlayout.clear();
    this.turnArbiter.clear();
    this.turnUserStoppedAtMs.clear();
    this.firstTtsAudioFired.clear();
    this.fallbackInjectedContexts.clear();
    this.ttsTextBuffers.clear();
    this.interruptedGenerationContextIds.clear();
    this.firstLlmDeltaReceived.clear();
    for (const [contextId, pending] of this.pendingToolCues) {
      for (const toolId of pending.keys()) this.scheduler.cancel(toolCueTimerKey(contextId, toolId));
    }
    this.pendingToolCues.clear();

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

  requestClientInterrupt(contextId: string): void {
    // Playing out → the arbiter owns the barge-in (primary-speaker reset + metrics).
    if (this.ttsPlayout.isActive(contextId)) {
      this.turnArbiter.commitClientInterrupt(contextId);
      return;
    }
    // Thinking-phase barge-in (B3): no audio yet, but a generation is in-flight —
    // abort it so "stop" during the reasoner TTFT gap is honored, not dropped.
    if (this.generatingContextIds.has(contextId)) {
      this.bus.push(Route.Critical, make.interruptDetected(contextId, Date.now(), "client"));
    }
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
    this.bus.on("turn.change", () => {
      this.lastFinalizedContextId = "";
    });
    this.bus.on("eos.turn_complete", this.handleTurnComplete.bind(this));
    this.bus.on("eos.interim", this.handleEosInterim.bind(this));

    // LLM
    this.bus.on("llm.delta", this.handleLlmDelta.bind(this));
    this.bus.on("llm.done", this.handleLlmDone.bind(this));
    this.bus.on("llm.tool_call", this.handleLlmToolCall.bind(this));
    this.bus.on("llm.tool_result", this.handleLlmToolResult.bind(this));

    // Delegate (Responder-Thinker) observability — G2, RFC bimodel-delegate-seam
    this.bus.on("delegate.query", this.handleDelegateQuery.bind(this));
    this.bus.on("delegate.result", this.handleDelegateResult.bind(this));

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

    this.observabilityObserver.wire();
  }

  // =========================================================================
  // Handler Implementations
  // =========================================================================

  private handleUserAudio(pkt: UserAudioReceivedPacket): void {
    if (this.shouldEnrollPrimarySpeaker(pkt.contextId)) {
      this.primarySpeakerGate.enrollUserTurnChunk(pkt.audio);
    }
    if (this.endpointingOwner === "provider_stt") {
      this.bus.push(
        Route.Main,
        make.recordUserAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
        make.vadAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
        make.sttAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
      );
    } else {
      this.bus.push(
        Route.Main,
        make.recordUserAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
        make.vadAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
        make.sttAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
        make.eosAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
      );
    }

    this.debugPush({
      component: "input",
      type: "audio_received",
      data: { context_id: pkt.contextId, bytes: String(pkt.audio.length) },
      timestampMs: pkt.timestampMs,
    });

    this.watchdogs.scheduleInputCadenceWatchdog(pkt.contextId);
  }

  private handleSttAudio(pkt: SpeechToTextAudioPacket): void {
    this.watchdogs.scheduleSttForceFinalize(pkt.contextId);
  }

  private handleUserText(pkt: UserTextReceivedPacket): void {
    // Treat text input as an immediate EOS turn complete
    this.bus.push(Route.Main, make.eosTurnComplete(pkt.contextId, pkt.timestampMs, pkt.text, []));
  }

  private handleSttInterim(pkt: SttInterimPacket): void {
    this.turnArbiter.noteInterimEvidence(pkt.text);
    this.maybeBargeInFromProviderStt(pkt.contextId, pkt.text, pkt.timestampMs);
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
    this.watchdogs.clearSttForceFinalizeIfContext(pkt.contextId);
    this.turnArbiter.noteInterimEvidence(pkt.text, pkt.confidence);
    this.maybeBargeInFromProviderStt(pkt.contextId, pkt.text, pkt.timestampMs);
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
    if (this.turnArbiter.observeBargeInAudio(pkt)) return;

    if (this.shouldEnrollPrimarySpeaker(pkt.contextId)) {
      this.primarySpeakerGate.enrollUserTurnChunk(pkt.audio);
    }
  }

  private shouldEnrollPrimarySpeaker(contextId: string): boolean {
    return (
      !this.latestActiveTtsContextId() &&
      this.speakerEnrollmentContextId === contextId
    );
  }

  // Deployments that delegate endpointing to the provider STT register no VAD
  // plugin, so vad.speech_started never fires and barge-in would stay dormant.
  // Provider transcripts arriving while TTS playout is active are the speech
  // evidence instead (echo of our own playout is mitigated by client AEC plus
  // the arbiter's backchannel / low-confidence suppression).
  private maybeBargeInFromProviderStt(contextId: string, text: string, timestampMs: number): void {
    if (this.endpointingOwner !== "provider_stt") return;
    if (!text.trim()) return;
    const interruptedContextId = this.latestActiveTtsContextId();
    if (!interruptedContextId) return;
    this.turnArbiter.onProviderSttEvidence(contextId, timestampMs, interruptedContextId);
  }

  private handleVadSpeechStarted(pkt: VadSpeechStartedPacket): void {
    this.lastFinalizedContextId = "";

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
    if (!interruptedContextId) {
      this.speakerEnrollmentContextId = pkt.contextId;
      return;
    }

    this.turnArbiter.onSpeechStarted(pkt, interruptedContextId);
  }

  private handleVadSpeechActivity(pkt: VadSpeechActivityPacket): void {
    this.turnArbiter.onSpeechActivity(pkt);
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

    if (this.speakerEnrollmentContextId === pkt.contextId) {
      this.speakerEnrollmentContextId = null;
    }

    this.turnArbiter.onSpeechEnded(pkt, Boolean(this.latestActiveTtsContextId()));

    this.turnUserStoppedAtMs.set(pkt.contextId, pkt.timestampMs);
    this.watchdogs.startVaqiMissedResponseTimer(pkt.contextId, pkt.timestampMs);
  }

  private handleTurnComplete(pkt: EndOfSpeechPacket): void {
    if (this.lastFinalizedContextId === pkt.contextId) {
      this.bus.push(Route.Background, make.metric(pkt.contextId, "eos.duplicate_dropped", "1"));
      return;
    }

    // A backchannel ("uh-huh", "okay") uttered WHILE the assistant is still speaking
    // is not a turn (B4). Dropping it here does two things: it does NOT cancel the
    // assistant's in-flight answer (the supersede path below would otherwise kill it),
    // and it does NOT spawn a second LLM response to the backchannel (the double-reply
    // bug). A backchannel with no assistant currently speaking IS a real turn — only
    // suppress when another context's TTS is actively playing. (English-only classifier
    // today — locale-aware backchannels are a separate improvement.)
    const otherTtsActive = this.ttsPlayout.activeContexts().some((c) => c !== pkt.contextId);
    if (otherTtsActive && isBackchannel(pkt.text)) {
      this.bus.push(Route.Background, make.metric(pkt.contextId, "turn.backchannel_dropped", pkt.text));
      return;
    }

    this.lastFinalizedContextId = pkt.contextId;

    // Re-arm per-turn guard state for the next turn. Transports with a stable
    // per-call contextId (telephony callSid) reuse one id across turns, so these
    // Sets must be cleared at the turn boundary or turn 2+ inherits stale flags:
    // - firstTtsAudioFired: else vaqi.latency_ms is never emitted again
    // - interruptedGenerationContextIds: else turn N+1's LLM/TTS packets are dropped after a prior barge-in
    // - fallbackInjectedContexts: else only one error fallback can ever be spoken per call
    this.firstTtsAudioFired.delete(pkt.contextId);
    this.interruptedGenerationContextIds.delete(pkt.contextId);
    this.fallbackInjectedContexts.delete(pkt.contextId);

    // Supersede (L1): a new turn must cancel any still-active prior-turn TTS or
    // generation. Without this, a false-EOS (early endpoint on a mid-sentence
    // pause) starts turn N, the user resumes, turn N's already-emitted audio
    // keeps synthesizing, and it plays over the user while turn N+1 is answered.
    // The bridge supersedes the *LLM*; only the session can stop the *TTS*.
    for (const activeCtx of this.ttsPlayout.activeContexts()) {
      if (activeCtx !== pkt.contextId) this.cancelStaleGeneration(activeCtx, pkt.timestampMs);
    }

    this.generatingContextIds.add(pkt.contextId);
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

    // Stop idle timeout while the LLM processes. The user just spoke — that is
    // genuine engagement, so reset the idle *escalation* count (P2): a user who
    // answers the first "are you there?" must not be escalated straight to the
    // disconnect prompt later in the call.
    this.bus.push(Route.Main, make.stopIdleTimeout(pkt.contextId, Date.now(), true));

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
    this.generatingContextIds.delete(pkt.contextId);
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
    this.turnArbiter.emitInterruptDetected(contextId);
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

    // G3: arm the typed preamble/filler lifecycle for this pending tool call.
    const pending = this.pendingToolCues.get(pkt.contextId) ?? new Map<string, string>();
    pending.set(pkt.toolId, pkt.toolName);
    this.pendingToolCues.set(pkt.contextId, pending);
    this.emitToolCallCue(pkt.contextId, "started", pkt.toolId, pkt.toolName);
    if (this.delayCueAfterMs > 0) {
      const afterMs = this.delayCueAfterMs;
      this.scheduler.schedule(toolCueTimerKey(pkt.contextId, pkt.toolId), afterMs, () => {
        if (!this.pendingToolCues.get(pkt.contextId)?.has(pkt.toolId)) return;
        this.emitToolCallCue(pkt.contextId, "delayed", pkt.toolId, pkt.toolName, afterMs);
      });
    }
  }

  private emitToolCallCue(
    contextId: string,
    phase: "started" | "delayed" | "complete" | "failed",
    toolId: string,
    toolName: string,
    afterMs?: number,
  ): void {
    this.emit("tool_call_cue", {
      tsMs: Date.now(),
      turnId: contextId,
      phase,
      toolId,
      toolName,
      ...(afterMs !== undefined ? { afterMs } : {}),
    });
  }

  /** G3: resolve one pending tool call with a terminal cue phase. */
  private resolveToolCue(contextId: string, toolId: string, phase: "complete" | "failed"): void {
    const pending = this.pendingToolCues.get(contextId);
    const toolName = pending?.get(toolId);
    if (toolName === undefined) return;
    pending!.delete(toolId);
    if (pending!.size === 0) this.pendingToolCues.delete(contextId);
    this.scheduler.cancel(toolCueTimerKey(contextId, toolId));
    this.emitToolCallCue(contextId, phase, toolId, toolName);
  }

  /** G3: fail every pending tool call for a context (error / barge-in / supersede). */
  private failPendingToolCues(contextId: string): void {
    const pending = this.pendingToolCues.get(contextId);
    if (!pending) return;
    for (const toolId of [...pending.keys()]) this.resolveToolCue(contextId, toolId, "failed");
  }

  private handleDelegateQuery(pkt: DelegateQueryPacket): void {
    this.emit("delegate_query", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
      query: pkt.query,
      toolId: pkt.toolId,
      toolName: pkt.toolName,
    });
    this.debugPush({
      component: "delegate",
      type: "query",
      data: {
        context_id: pkt.contextId,
        query: pkt.query,
        ...(pkt.toolName ? { tool_name: pkt.toolName } : {}),
      },
      timestampMs: pkt.timestampMs,
    });
  }

  private handleDelegateResult(pkt: DelegateResultPacket): void {
    this.emit("delegate_result", {
      tsMs: pkt.timestampMs,
      turnId: pkt.contextId,
      query: pkt.query,
      answer: pkt.answer,
      durationMs: pkt.durationMs,
      grounded: pkt.grounded,
      toolId: pkt.toolId,
      toolName: pkt.toolName,
    });
    this.debugPush({
      component: "delegate",
      type: "result",
      data: {
        context_id: pkt.contextId,
        duration_ms: String(pkt.durationMs),
        grounded: String(pkt.grounded),
      },
      timestampMs: pkt.timestampMs,
    });
  }

  private handleLlmToolResult(pkt: LlmToolResultPacket): void {
    this.resolveToolCue(pkt.contextId, pkt.toolId, "complete");
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
      this.watchdogs.clearVaqiIfContext(pkt.contextId);
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
    this.watchdogs.armTtsStallTimer(pkt.contextId);

    // Mark active and advance this context's playout cursor by the chunk's
    // realtime duration.
    const sampleRateHz = requireTtsAudioSampleRate(pkt.sampleRateHz);
    const audioDurationMs = estimatePcm16Duration(pkt.audio, sampleRateHz);
    const now = Date.now();
    this.ttsPlayout.noteAudio(pkt.contextId, audioDurationMs, now);

    // Anchor the idle timer to when playout actually *ends* (P2), not to chunk
    // arrival. TTS streams faster than realtime, so extending by each chunk's
    // duration from arrival lets the timer fire mid-speech on a long answer.
    // playoutEnd() is cumulative across chunks, so this re-arms to durationMs
    // after the audio delivered so far finishes playing.
    const playoutEndMs = this.ttsPlayout.playoutEnd(pkt.contextId);
    this.idleTimeout.extend(playoutEndMs !== undefined ? Math.max(0, playoutEndMs - now) : audioDurationMs);

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
    this.generatingContextIds.delete(pkt.contextId);
    this.ttsPlayout.scheduleRelease(pkt.contextId, Date.now());
    this.watchdogs.clearTtsStallTimerFor(pkt.contextId);
    this.debugPush({
      component: "tts",
      type: "end",
      data: {},
      timestampMs: Date.now(),
    });
  }

  private handleTtsPlayoutProgress(pkt: TextToSpeechPlayoutProgressPacket): void {
    this.ttsPlayout.noteProgress(pkt.contextId, pkt.complete, pkt.playedOutMs);
  }

  private handleInterruptDetected(pkt: InterruptionDetectedPacket): void {
    this.interruptedGenerationContextIds.add(pkt.contextId);
    this.failPendingToolCues(pkt.contextId); // G3: the aborted delegate's cue fails (R5)
    this.latencyFiller.cancel(pkt.contextId);
    this.firstLlmDeltaReceived.delete(pkt.contextId);
    this.ttsTextBuffers.delete(pkt.contextId);
    this.ttsPlayout.release(pkt.contextId);
    this.watchdogs.clearTtsStallTimerFor(pkt.contextId);
    this.debugPush({
      component: "turn",
      type: "interrupt_detected",
      data: {
        context_id: pkt.contextId,
        source: pkt.source,
      },
      timestampMs: pkt.timestampMs,
    });

    this.bus.push(
      Route.Background,
      make.metric(
        pkt.contextId,
        "interrupt.onset_to_logic_cancel_ms",
        String(Math.max(0, Date.now() - pkt.timestampMs)),
      ),
    );

    // Stop idle timeout
    this.bus.push(Route.Critical, make.stopIdleTimeout(pkt.contextId, Date.now(), true));

    this.bus.push(Route.Critical, make.recordAssistantTruncate(pkt.contextId, Date.now()));

    // Interrupt TTS, then LLM
    this.bus.push(Route.Critical, make.interruptTts(pkt.contextId, pkt.timestampMs));
    this.bus.push(Route.Critical, make.interruptLlm(pkt.contextId, pkt.timestampMs));
    // Reset STT transcript state too, so a barge-in cannot leak stale finalized
    // segments into the next turn when a client reuses the same contextId
    // (the provider STT plugins listen for interrupt.stt; previously unfired).
    this.bus.push(Route.Critical, make.interruptStt(pkt.contextId, pkt.timestampMs));
    this.generatingContextIds.delete(pkt.contextId);
  }

  /**
   * Cancel a stale prior-turn generation/playout when a new turn supersedes it
   * (L1). Mirrors the interrupt teardown but without the barge-in metrics — this
   * is a turn boundary, not a user interruption. Stops leftover TTS audio, aborts
   * the LLM, and drops late deltas/audio for the stale context.
   */
  private cancelStaleGeneration(contextId: string, timestampMs: number): void {
    this.interruptedGenerationContextIds.add(contextId);
    this.failPendingToolCues(contextId); // G3: a superseded turn's pending cue fails
    this.generatingContextIds.delete(contextId);
    this.latencyFiller.cancel(contextId);
    this.firstLlmDeltaReceived.delete(contextId);
    this.ttsTextBuffers.delete(contextId);
    this.ttsPlayout.release(contextId);
    this.watchdogs.clearTtsStallTimerFor(contextId);
    this.bus.push(Route.Critical, make.recordAssistantTruncate(contextId, Date.now()));
    this.bus.push(Route.Critical, make.interruptTts(contextId, timestampMs));
    this.bus.push(Route.Critical, make.interruptLlm(contextId, timestampMs));
    this.bus.push(Route.Background, make.metric(contextId, "supersede.cancelled_stale_generation", "1"));
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

    // G3: an LLM/bridge error while a tool call is pending means no result is coming.
    if (pkt.component === "llm" || pkt.component === "bridge") {
      this.failPendingToolCues(pkt.contextId);
    }
    this.latencyFiller.clear(pkt.contextId);
    this.generatingContextIds.delete(pkt.contextId);
    // The packet's own recoverability verdict is authoritative when present: the
    // bus marks handler exceptions (pipeline.error) recoverable by design — one
    // misbehaving handler must degrade the turn, not kill the whole call.
    const recoverable = typeof pkt.isRecoverable === "boolean" ? pkt.isRecoverable : isRecoverable(pkt.category);
    if (!recoverable) {
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
    this.applyEndpointingOwnerInvariant();

    for (const [name, plugin] of this.plugins) {
      if (!this.shouldInitializePlugin(plugin)) continue;
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

  private applyEndpointingOwnerInvariant(): void {
    if (this.endpointingOwner === "timer") return;
    const owner: EndpointingOwner = this.endpointingOwner;
    const finalizers = [...this.plugins.entries()]
      .filter(([, plugin]) => plugin.endpointingCapability !== undefined);
    const enabledFinalizers = finalizers
      .filter(([, plugin]) => plugin.endpointingCapability?.owner === owner);
    if (finalizers.length > 0 && enabledFinalizers.length !== 1) {
      throw new Error(
        `endpointingOwner=${owner} requires exactly one registered ${owner} EOS finalizer; found ${String(enabledFinalizers.length)}`,
      );
    }
    for (const [name, plugin] of finalizers) {
      if (plugin.endpointingCapability?.owner === owner) continue;
      const disabled = plugin.endpointingCapability?.disableConfig;
      if (!disabled) continue;
      this.config.plugins[name] = {
        ...(this.config.plugins[name] ?? {}),
        ...disabled,
      };
    }
  }

  private shouldInitializePlugin(plugin: VoicePlugin): boolean {
    const capability = plugin.endpointingCapability;
    if (!capability) return true;
    if (this.endpointingOwner === "timer") return false;
    if (capability.owner === "smart_turn") return capability.owner === this.endpointingOwner;
    return true;
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

  private latestActiveTtsContextId(): string {
    return this.ttsPlayout.latestActive();
  }
}
