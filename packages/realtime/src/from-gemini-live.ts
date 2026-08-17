// SPDX-License-Identifier: MIT

import type {
  GoogleGenAI,
  LiveCallbacks,
  Session,
  LiveServerMessage,
  UsageMetadata,
  Behavior,
  FunctionResponseScheduling,
} from "@google/genai";

import { bytesToBase64, base64ToBytes } from "./base64.js";
import { RealtimeEventStream } from "./realtime-event-stream.js";
import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef, RealtimeUsage } from "./realtime-adapter.js";

const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const INPUT_SAMPLE_RATE_HZ = 16_000;
const OUTPUT_SAMPLE_RATE_HZ = 24_000;
/** In-flight tool-call ids awaiting a client result. Oldest evicted at cap (iu-ledger pattern). */
const MAX_TOOL_NAMES = 256;
/**
 * How long before the `goAway` deadline the adapter forces a reconnect even if a response
 * is still in flight. Measured against a 739ms median resumed reconnect and 50s of warning
 * (2026-08-16 spike) — a few seconds of margin comfortably absorbs that.
 */
const HARD_CUTOFF_MS = 5_000;

export interface GeminiLiveTranscriptionOptions {
  /**
   * Enable input transcription, or provide Gemini's AudioTranscriptionConfig. Enabled by default.
   *
   * Default stays ON because `RealtimeBridge` turns `role: "user"` transcripts into `stt.result`
   * packets — defaulting this off would silently remove all user-side text on the Gemini front.
   * Issue #32 asked for it to be *configurable*, not disabled.
   */
  readonly input?: boolean | Record<string, unknown>;
  /** Enable output transcription, or provide Gemini's AudioTranscriptionConfig. Enabled by default. */
  readonly output?: boolean | Record<string, unknown>;
}

export interface GeminiLiveSpeechConfig {
  /** Prebuilt Gemini voice name, mapped to speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName. */
  readonly voice?: string;
  /** ISO language code for speech synthesis. */
  readonly languageCode?: string;
}

export interface GeminiLiveOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly systemInstruction?: string;
  readonly tools?: readonly RealtimeToolDef[];
  readonly transcription?: GeminiLiveTranscriptionOptions;
  readonly speechConfig?: GeminiLiveSpeechConfig;
  /** Gemini Developer API version, e.g. `v1alpha` for preview-only Live features. */
  readonly apiVersion?: string;
  /**
   * G4 native resume: a `sessionResumption` handle from a prior session's
   * `resumption_handle` events. Gemini restores the conversation server-side —
   * do NOT also replay the transcript (that would double-apply history, R6).
   * Session resumption is always enabled so handles are issued; this passes a
   * prior handle back on reconnect.
   */
  readonly sessionResumptionHandle?: string;
  /**
   * Full `sessionResumption` LiveConnectConfig. Defaults to `{}` (handles issued)
   * or `{ handle }` when `sessionResumptionHandle` is set. Pass `false` to omit.
   */
  readonly sessionResumption?: Record<string, unknown> | false;
  /** Response modalities. Defaults to `["AUDIO"]` (previous hard-pin). */
  readonly responseModalities?: readonly string[];
  /** LiveConnectConfig `generationConfig` (subset supported by Live). */
  readonly generationConfig?: Record<string, unknown>;
  /** LiveConnectConfig `safetySettings`. */
  readonly safetySettings?: readonly Record<string, unknown>[];
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly maxOutputTokens?: number;
  readonly mediaResolution?: string;
  readonly seed?: number;
  readonly thinkingConfig?: Record<string, unknown>;
  readonly enableAffectiveDialog?: boolean;
  readonly realtimeInputConfig?: Record<string, unknown>;
  /**
   * Disable Gemini's server VAD so Syrinx endpointing/VAD/InteractionPolicy owns the turn
   * (REQ-6). Merges `realtimeInputConfig.automaticActivityDetection.disabled: true` into
   * whatever `realtimeInputConfig` the caller already supplied — it does not replace it.
   * Default false: an adapter configured as today produces a byte-identical connect config.
   */
  readonly manualActivityDetection?: boolean;
  readonly contextWindowCompression?: Record<string, unknown>;
  readonly proactivity?: Record<string, unknown>;
  readonly explicitVadSignal?: boolean;
  /**
   * Merged last into `live.connect` config for any LiveConnectConfig field the
   * adapter does not enumerate (avatarConfig, …). Overrides same-key defaults.
   */
  readonly connectConfig?: Record<string, unknown>;
}

class GeminiLiveAdapter implements RealtimeAdapter {
  readonly caps = {
    inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    outputSampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
    supportsConcurrentToolAudio: false,
    supportsTruncate: false,
    emitsServerSpeechStarted: true,
    supportsNativeResume: true,
    // Every live-capable Gemini model accepts `behavior: NON_BLOCKING` — measured across all
    // five on the account, 2026-08-16, with a behavioural differential rather than mere setup
    // acceptance. Unconditional on purpose: if Google ever ships a live model that rejects it,
    // this cap is where that gets expressed, not a model-id check scattered through the adapter.
    supportsToolBehavior: true,
  } as const;

  readonly events: AsyncIterable<RealtimeEvent>;

  private readonly stream = new RealtimeEventStream();
  // G4/goAway: one open() can now silently span several provider sessions — a `goAway`
  // deadline swaps `session` (and bumps `generation`) without ending `stream`. `ai`/`model`
  // are cached from open() so a reconnect can rebuild the connect config and re-call
  // `live.connect` without the caller re-supplying anything.
  private ai: GoogleGenAI | null = null;
  private model = "";
  private audioModality = "AUDIO";
  /**
   * Cached from the same dynamic `@google/genai` import as `Modality` (open()), so
   * `buildConnectConfig()` and `injectToolResult()` map to the SDK's real enum values rather
   * than raw string literals, without a top-level static import of the package.
   */
  private behaviorEnum: typeof Behavior | null = null;
  private schedulingEnum: typeof FunctionResponseScheduling | null = null;
  private session: Session | null = null;
  private abortHandler: (() => void) | null = null;
  private openResolver: (() => void) | null = null;
  private openRejecter: ((err: Error) => void) | null = null;
  private activeResponse = false;
  private readonly toolNames = new Map<string, { name: string; providerId: string | undefined }>();
  /**
   * Ids Gemini has told us it discarded (`toolCallCancellation`) — tracked so a later
   * `injectToolResult` for one is a silent no-op rather than the `unknown tool id` error
   * path (that error reports a fault; a cancellation is not one). Bounded like `toolNames`
   * (iu-ledger pattern) so an id whose delegate turn never answers back can't leak.
   */
  private readonly cancelledToolIds = new Set<string>();
  /** Latest `usageMetadata` for the in-flight turn, attached to `response_done` and cleared there. */
  private pendingUsage: RealtimeUsage | undefined;
  /** Bumped on every (re)connect; callbacks captured from a retired session no-op once stale. */
  private generation = 0;
  private closed = false;
  private latestResumptionHandle: string | undefined;
  private goAwayDeadlineAtMs: number | undefined;
  private reestablishing = false;
  private hardCutoffTimer: ReturnType<typeof setTimeout> | null = null;
  /** Static for the adapter's lifetime — a caller-chosen mode, not per-session state, so it
   *  needs no release on reconnect/close (unlike toolNames/cancelledToolIds/pendingUsage). */
  private readonly manual: boolean;

  constructor(private readonly opts: GeminiLiveOptions) {
    this.events = this.stream;
    this.latestResumptionHandle = opts.sessionResumptionHandle;
    this.manual = opts.manualActivityDetection === true;
  }

  async open(signal: AbortSignal): Promise<void> {
    const { GoogleGenAI, Modality, Behavior, FunctionResponseScheduling } = await import(
      "@google/genai"
    );
    this.model = this.opts.model ?? DEFAULT_MODEL;
    this.audioModality = Modality.AUDIO;
    this.behaviorEnum = Behavior;
    this.schedulingEnum = FunctionResponseScheduling;

    const config = this.buildConnectConfig();

    const openPromise = new Promise<void>((resolve, reject) => {
      this.openResolver = resolve;
      this.openRejecter = reject;
    });

    this.ai = new GoogleGenAI({
      apiKey: this.opts.apiKey,
      ...(this.opts.apiVersion === undefined
        ? {}
        : { httpOptions: { apiVersion: this.opts.apiVersion } }),
    });

    this.session = await this.connectSession(config);

    this.abortHandler = () => {
      void this.close();
      this.rejectOpen(new Error("Gemini Live adapter open aborted"));
    };
    signal.addEventListener("abort", this.abortHandler, { once: true });

    await openPromise;
  }

  /**
   * Build the LiveConnectConfig for `live.connect`, from `opts` and the latest resumption
   * handle. Reused verbatim on the initial connect and on every goAway-triggered reconnect
   * (WBS action item 4) so a rebuilt config differs from the original only in
   * `sessionResumption.handle`.
   */
  private buildConnectConfig(): Record<string, unknown> {
    const tools = (this.opts.tools ?? []).map((t) => ({
      functionDeclarations: [{
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parameters,
        // Per-tool opt-in, and only when the adapter can express it at all — an omitted
        // `behavior` must produce a byte-identical setup frame for every existing agent.
        ...(t.behavior !== undefined && this.caps.supportsToolBehavior
          ? { behavior: this.mapToolBehavior(t.behavior) }
          : {}),
      }],
    }));

    const transcription = this.opts.transcription;
    const config: Record<string, unknown> = {
      // Default preserves the prior hard-pin of AUDIO-only responses.
      responseModalities: this.opts.responseModalities
        ? [...this.opts.responseModalities]
        : [this.audioModality],
    };
    // G4: session resumption defaults ON so the server issues handles; the latest known
    // handle resumes server-side (native resume — no replay). Override via
    // sessionResumption (full object) or disable with false.
    if (!("sessionResumption" in this.opts) || this.opts.sessionResumption !== false) {
      const base =
        typeof this.opts.sessionResumption === "object" && this.opts.sessionResumption !== null
          ? { ...this.opts.sessionResumption }
          : {};
      if (this.latestResumptionHandle !== undefined) {
        base["handle"] = this.latestResumptionHandle;
      }
      config["sessionResumption"] = base;
    }
    const inputTranscription = transcription?.input ?? true;
    const outputTranscription = transcription?.output ?? true;
    if (inputTranscription !== false) {
      config["inputAudioTranscription"] = inputTranscription === true ? {} : inputTranscription;
    }
    if (outputTranscription !== false) {
      config["outputAudioTranscription"] = outputTranscription === true ? {} : outputTranscription;
    }
    const speechConfig = this.opts.speechConfig;
    if (speechConfig && (speechConfig.voice !== undefined || speechConfig.languageCode !== undefined)) {
      config["speechConfig"] = {
        ...(speechConfig.voice === undefined
          ? {}
          : { voiceConfig: { prebuiltVoiceConfig: { voiceName: speechConfig.voice } } }),
        ...(speechConfig.languageCode === undefined ? {} : { languageCode: speechConfig.languageCode }),
      };
    }
    if (this.opts.systemInstruction) {
      config["systemInstruction"] = this.opts.systemInstruction;
    }
    if (tools.length > 0) {
      config["tools"] = tools;
    }
    if (this.opts.generationConfig !== undefined) {
      config["generationConfig"] = this.opts.generationConfig;
    }
    if (this.opts.safetySettings !== undefined) {
      config["safetySettings"] = this.opts.safetySettings;
    }
    if (this.opts.temperature !== undefined) {
      config["temperature"] = this.opts.temperature;
    }
    if (this.opts.topP !== undefined) {
      config["topP"] = this.opts.topP;
    }
    if (this.opts.topK !== undefined) {
      config["topK"] = this.opts.topK;
    }
    if (this.opts.maxOutputTokens !== undefined) {
      config["maxOutputTokens"] = this.opts.maxOutputTokens;
    }
    if (this.opts.mediaResolution !== undefined) {
      config["mediaResolution"] = this.opts.mediaResolution;
    }
    if (this.opts.seed !== undefined) {
      config["seed"] = this.opts.seed;
    }
    if (this.opts.thinkingConfig !== undefined) {
      config["thinkingConfig"] = this.opts.thinkingConfig;
    }
    if (this.opts.enableAffectiveDialog !== undefined) {
      config["enableAffectiveDialog"] = this.opts.enableAffectiveDialog;
    }
    if (this.manual) {
      // Merged, not replaced: realtimeInputConfig is already a caller-facing passthrough, so
      // overwriting it here would silently drop a caller's sensitivity/turnCoverage settings.
      // Built inside buildConnectConfig() (not open()) so a goAway reconnect — which rebuilds
      // the config from scratch — re-applies manual mode instead of reverting to server VAD.
      const callerConfig = this.opts.realtimeInputConfig ?? {};
      const callerAad =
        (callerConfig["automaticActivityDetection"] as Record<string, unknown> | undefined) ?? {};
      config["realtimeInputConfig"] = {
        ...callerConfig,
        automaticActivityDetection: { ...callerAad, disabled: true },
      };
    } else if (this.opts.realtimeInputConfig !== undefined) {
      config["realtimeInputConfig"] = this.opts.realtimeInputConfig;
    }
    if (this.opts.contextWindowCompression !== undefined) {
      config["contextWindowCompression"] = this.opts.contextWindowCompression;
    }
    if (this.opts.proactivity !== undefined) {
      config["proactivity"] = this.opts.proactivity;
    }
    if (this.opts.explicitVadSignal !== undefined) {
      config["explicitVadSignal"] = this.opts.explicitVadSignal;
    }
    if (this.opts.connectConfig) {
      Object.assign(config, this.opts.connectConfig);
    }
    return config;
  }

  /** Call `live.connect` under the current generation, so a retired session's late callbacks no-op. */
  private async connectSession(config: Record<string, unknown>): Promise<Session> {
    const generation = ++this.generation;
    return this.requireAi().live.connect({
      model: this.model,
      config,
      callbacks: this.buildCallbacks(generation),
    });
  }

  private buildCallbacks(generation: number): LiveCallbacks {
    return {
      onopen: () => {
        if (generation !== this.generation) return;
        this.resolveOpen();
      },
      onmessage: (msg) => {
        if (generation !== this.generation) return;
        this.handleMessage(msg);
      },
      onerror: (ev) => {
        if (generation !== this.generation) return;
        const cause = ev instanceof Error ? ev : new Error(String(ev));
        this.stream.push({ type: "error", cause, recoverable: true });
        this.rejectOpen(cause);
      },
      onclose: (ev) => {
        if (generation !== this.generation) return;
        const reason =
          ev && typeof ev === "object" && "reason" in ev && typeof ev.reason === "string"
            ? ev.reason.trim()
            : "";
        if (reason) {
          this.stream.push({ type: "error", cause: new Error(reason), recoverable: false });
        }
        this.stream.close();
      },
    };
  }

  sendAudio(pcm16: Uint8Array): void {
    this.requireSession().sendRealtimeInput({
      audio: {
        data: bytesToBase64(pcm16),
        mimeType: "audio/pcm;rate=16000",
      },
    });
  }

  sendText(text: string): void {
    this.requireSession().sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    });
  }

  injectContext(text: string): void {
    // Gemini Live drops system/developer roles from conversation history. A silent,
    // incomplete user turn preserves the steering context without requesting a response.
    this.requireSession().sendClientContent({
      turns: [{ role: "user", parts: [{ text: `[Context-only instruction]\n${text}` }] }],
      turnComplete: false,
    });
  }

  cancelResponse(_audioEndMs: number): void {
    // Gemini handles interruption server-side via `interrupted`; no truncate API.
  }

  /**
   * Manual-activity-detection mode ONLY. Call when Syrinx's own VAD/endpointing/
   * InteractionPolicy detects the start of user speech. A no-op (with a surfaced error)
   * outside manual mode: sending an activity signal while Gemini's own VAD is enabled is a
   * client error, not a silent ignore, since it means the caller's mode wiring is wrong.
   */
  startUserActivity(): void {
    if (!this.manual) {
      this.stream.push({
        type: "error",
        cause: new Error(
          "Gemini Live adapter: startUserActivity() requires manualActivityDetection",
        ),
        recoverable: true,
      });
      return;
    }
    this.requireSession().sendRealtimeInput({ activityStart: {} });
  }

  /**
   * On Gemini, `activityEnd` IS the generation trigger — unlike OpenAI's `requestResponse`,
   * which commits the audio buffer and then sends a separate `response.create`, Gemini has no
   * second "start generating" message: ending the input activity is what asks the server to
   * respond. Outside manual mode this is silently a no-op (server VAD already generates a
   * response on its own) rather than a surfaced error, because `RealtimeBridge` calls
   * `requestResponse` unconditionally on every `eos.turn_complete` — an error here would fire
   * on every ordinary turn of a non-manual session.
   */
  requestResponse(): void {
    if (!this.manual) return;
    this.requireSession().sendRealtimeInput({ activityEnd: {} });
  }

  /**
   * A NON_BLOCKING tool call can answer progressively: send `willContinue: true` for each
   * intermediate ("still looking") response, then a terminal one (`willContinue` absent or
   * `false`) to finish the call — the same `toolId` answered more than once. Per
   * `@google/genai@2.8.0`, an empty `response` with `willContinue: false` finishes the call
   * but may still trigger model generation; to finish without generating, also pass
   * `scheduling: "SILENT"`.
   */
  injectToolResult(
    toolId: string,
    text: string,
    opts?: { scheduling?: "SILENT" | "WHEN_IDLE" | "INTERRUPT"; willContinue?: boolean },
  ): void {
    const entry = this.toolNames.get(toolId);
    if (!entry) {
      // The id may be missing because Gemini already cancelled it (toolCallCancellation) and
      // the reasoner turn raced the cancellation, answering anyway. That is not a fault — the
      // cancellation already told us the server discarded the call — so drop the late answer
      // silently instead of reporting an error for a call nothing will ever accept.
      if (this.cancelledToolIds.delete(toolId)) return;
      this.stream.push({
        type: "error",
        cause: new Error(`unknown tool id "${toolId}" for Gemini tool response`),
        recoverable: false,
      });
      return;
    }
    this.requireSession().sendToolResponse({
      functionResponses: [{
        ...(entry.providerId !== undefined ? { id: entry.providerId } : {}),
        name: entry.name,
        // Top level, siblings of `response` — NOT nested inside it. `FunctionResponse` in
        // @google/genai@2.8.0 declares `scheduling` and `willContinue` beside `response`, and a
        // live differential (2026-08-16) confirmed the nested position is inert: the model
        // ignored a nested `SILENT` and spoke anyway, while a top-level one correctly silenced it.
        ...(opts?.scheduling !== undefined
          ? { scheduling: this.mapToolScheduling(opts.scheduling) }
          : {}),
        ...(opts?.willContinue !== undefined ? { willContinue: opts.willContinue } : {}),
        response: { result: text },
      }],
    });
    // Release ONLY on a terminal response (willContinue absent or false). NOT on turnComplete:
    // turnComplete fires while a NON_BLOCKING call is still outstanding on both tested models
    // (gemini-3.1-flash-live-preview, gemini-2.5-flash-native-audio-latest), the outstanding
    // call is not cancelled by the new turn, and answering it after turnComplete is still
    // honoured by the server — evicting there would fail a late answer the server would have
    // accepted. Decision: toolNames entries release on the terminal tool response, never on
    // turnComplete, 2026-08-16 (live measurement).
    if (opts?.willContinue !== true) this.toolNames.delete(toolId);
  }

  async close(): Promise<void> {
    if (this.abortHandler) {
      // signal may already be gone; best-effort cleanup
    }
    this.closed = true;
    if (this.hardCutoffTimer !== null) {
      clearTimeout(this.hardCutoffTimer);
      this.hardCutoffTimer = null;
    }
    this.generation++;
    this.session?.close();
    this.session = null;
    this.toolNames.clear();
    this.cancelledToolIds.clear();
    this.pendingUsage = undefined;
    this.stream.close();
  }

  private trackToolName(
    toolId: string,
    entry: { name: string; providerId: string | undefined },
  ): void {
    if (!this.toolNames.has(toolId) && this.toolNames.size >= MAX_TOOL_NAMES) {
      const oldest = this.toolNames.keys().next().value;
      if (oldest !== undefined) this.toolNames.delete(oldest);
    }
    this.toolNames.set(toolId, entry);
  }

  private markCancelled(toolId: string): void {
    if (!this.cancelledToolIds.has(toolId) && this.cancelledToolIds.size >= MAX_TOOL_NAMES) {
      const oldest = this.cancelledToolIds.values().next().value;
      if (oldest !== undefined) this.cancelledToolIds.delete(oldest);
    }
    this.cancelledToolIds.add(toolId);
  }

  private requireSession(): Session {
    if (!this.session) throw new Error("Gemini Live adapter is not open");
    return this.session;
  }

  private requireAi(): GoogleGenAI {
    if (!this.ai) throw new Error("Gemini Live adapter is not open");
    return this.ai;
  }

  private requireBehaviorEnum(): typeof Behavior {
    if (!this.behaviorEnum) throw new Error("Gemini Live adapter is not open");
    return this.behaviorEnum;
  }

  private requireSchedulingEnum(): typeof FunctionResponseScheduling {
    if (!this.schedulingEnum) throw new Error("Gemini Live adapter is not open");
    return this.schedulingEnum;
  }

  /** Map the adapter-facing string literal onto the SDK's real `Behavior` enum member. */
  private mapToolBehavior(behavior: "BLOCKING" | "NON_BLOCKING"): Behavior {
    const enumObj = this.requireBehaviorEnum();
    return behavior === "NON_BLOCKING" ? enumObj.NON_BLOCKING : enumObj.BLOCKING;
  }

  /** Map the adapter-facing string literal onto the SDK's real `FunctionResponseScheduling` enum member. */
  private mapToolScheduling(
    scheduling: "SILENT" | "WHEN_IDLE" | "INTERRUPT",
  ): FunctionResponseScheduling {
    const enumObj = this.requireSchedulingEnum();
    switch (scheduling) {
      case "SILENT":
        return enumObj.SILENT;
      case "WHEN_IDLE":
        return enumObj.WHEN_IDLE;
      case "INTERRUPT":
        return enumObj.INTERRUPT;
    }
  }

  /** goAway: parse `timeLeft` and arm a deadline. Absent/unparseable => "reconnect now". */
  private armGoAwayDeadline(timeLeft: string | undefined): void {
    const leftMs = parseGoAwayTimeLeftMs(timeLeft);
    this.goAwayDeadlineAtMs = leftMs === undefined ? Date.now() : Date.now() + leftMs;
    this.armHardCutoffTimer();
    this.maybeReestablish();
  }

  /**
   * A response-complete boundary is the normal trigger for `maybeReestablish`, but a session
   * that goes idle right after `goAway` sends no more boundary events before the deadline —
   * this timer is the fallback that still fires the swap in that case.
   */
  private armHardCutoffTimer(): void {
    if (this.hardCutoffTimer !== null) {
      clearTimeout(this.hardCutoffTimer);
      this.hardCutoffTimer = null;
    }
    if (this.goAwayDeadlineAtMs === undefined) return;
    const delay = Math.max(0, this.goAwayDeadlineAtMs - HARD_CUTOFF_MS - Date.now());
    this.hardCutoffTimer = setTimeout(() => {
      this.hardCutoffTimer = null;
      this.maybeReestablish();
    }, delay);
  }

  /** Swap at the first safe boundary (idle) or at the hard cutoff, whichever comes first. */
  private maybeReestablish(): void {
    if (this.goAwayDeadlineAtMs === undefined || this.reestablishing) return;
    const atCutoff = Date.now() >= this.goAwayDeadlineAtMs - HARD_CUTOFF_MS;
    if (this.activeResponse && !atCutoff) return;
    this.reestablishing = true;
    void this.reestablish();
  }

  private async reestablish(): Promise<void> {
    if (this.hardCutoffTimer !== null) {
      clearTimeout(this.hardCutoffTimer);
      this.hardCutoffTimer = null;
    }
    const retired = this.session;
    const retiredGeneration = this.generation;
    const config = this.buildConnectConfig();
    let next: Session;
    try {
      next = await this.connectSession(config);
    } catch (err) {
      // The reconnect failed, so the retired session is still the live one. connectSession
      // has already bumped `generation`, which would silently mute that session's callbacks
      // for the rest of the call — restore it, or the socket stays open and goes deaf.
      this.generation = retiredGeneration;
      this.reestablishing = false;
      this.stream.push({
        type: "error",
        cause: err instanceof Error ? err : new Error(String(err)),
        recoverable: true,
      });
      // The deadline has not moved, so re-arm and try again before it expires rather than
      // leaving the call to die at a boundary we were warned about.
      this.armHardCutoffTimer();
      return;
    }
    if (this.closed) {
      next.close();
      return;
    }
    this.session = next;
    this.activeResponse = false;
    // The new session has no memory of a tool call the retired one issued — an id carried
    // across would fail its lookup on a response the new session never asked for.
    this.toolNames.clear();
    this.cancelledToolIds.clear();
    // A swap at the hard cutoff can land mid-response, after usageMetadata arrived but
    // before its turnComplete. Carried across, the retired turn's counts would attach to
    // the first turn the NEW session completes — a real turn billed with another's tokens.
    this.pendingUsage = undefined;
    this.goAwayDeadlineAtMs = undefined;
    this.reestablishing = false;
    // Reuse the OpenAI-compatible adapter's reconnect-notification shape (recoverable error)
    // rather than a new RealtimeEvent variant — a silent swap cannot be diagnosed in production.
    this.stream.push({
      type: "error",
      cause: new Error("Gemini Live session reestablished ahead of goAway"),
      recoverable: true,
    });
    retired?.close();
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

  private handleMessage(msg: LiveServerMessage): void {
    // G4: surface fresh resumption handles so a durable host can persist the latest, and
    // track the latest in-memory so a goAway reconnect can use it directly.
    const resumption = msg.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      this.latestResumptionHandle = resumption.newHandle;
      this.stream.push({ type: "resumption_handle", handle: resumption.newHandle });
    }

    if (msg.goAway) {
      this.armGoAwayDeadline(msg.goAway.timeLeft);
      return;
    }

    // Meter the native front — hold the latest usage for the in-flight turn so it can
    // attach to response_done below; previously response_done carried no usage at all.
    if (msg.usageMetadata) {
      this.pendingUsage = toRealtimeUsage(msg.usageMetadata);
    }

    // Gemini discards a pending tool call on barge-in and names it here — release trigger 2
    // of toolNames' three release triggers (terminal tool response, cancellation, session
    // close; Decision: toolNames entries release on the terminal tool response, never on
    // turnComplete, 2026-08-16). NOT turnComplete: turnComplete fires while a NON_BLOCKING
    // call is still outstanding on both tested models, and a late answer sent after it is
    // still honoured by the server — evicting at turnComplete would break an answer the
    // server would have accepted.
    const cancelledIds = msg.toolCallCancellation?.ids;
    if (cancelledIds?.length) {
      for (const id of cancelledIds) {
        this.toolNames.delete(id);
        this.markCancelled(id);
      }
      this.stream.push({ type: "tool_call_cancelled", toolIds: cancelledIds });
    }

    if (msg.setupComplete) {
      if (!this.activeResponse) {
        this.activeResponse = true;
        this.stream.push({ type: "response_started" });
      }
    }

    const content = msg.serverContent;
    if (content) {
      // Whether `interrupted` still fires with automaticActivityDetection.disabled (manual
      // mode) is undocumented and unverified live (2026-08-17 spike, see
      // interrupted_finding in runs/result-manualvad.json) — Google's docs describe it only
      // under automatic VAD ("when VAD detects an interruption..."), and separately state
      // that in manual mode "any interruption of the stream is marked by an activityEnd
      // message", without saying whether `interrupted` also fires. Left unconditional rather
      // than guessing either way: emitting speech_started here regardless of mode is the
      // conservative choice — dropping it in manual mode on an unverified assumption risks
      // silently losing barge-in detection.
      if (content.interrupted) {
        this.stream.push({ type: "speech_started" });
      }

      if (content.inputTranscription?.text) {
        this.stream.push({
          type: "transcript",
          role: "user",
          text: content.inputTranscription.text,
          final: content.inputTranscription.finished ?? false,
        });
      }

      if (content.outputTranscription?.text) {
        this.stream.push({
          type: "transcript",
          role: "assistant",
          text: content.outputTranscription.text,
          final: content.outputTranscription.finished ?? false,
        });
      }

      const parts = content.modelTurn?.parts;
      if (parts) {
        if (!this.activeResponse) {
          this.activeResponse = true;
          this.stream.push({ type: "response_started" });
        }
        for (const part of parts) {
          const inline = part.inlineData;
          if (inline?.data && inline.mimeType?.startsWith("audio/")) {
            const rateMatch = /rate=(\d+)/.exec(inline.mimeType);
            const sampleRateHz = rateMatch ? Number(rateMatch[1]) : OUTPUT_SAMPLE_RATE_HZ;
            this.stream.push({
              type: "audio",
              pcm16: base64ToBytes(inline.data),
              sampleRateHz,
            });
          }
        }
      }

      if (content.turnComplete) {
        this.activeResponse = false;
        const usage = this.pendingUsage;
        this.pendingUsage = undefined;
        this.stream.push(usage ? { type: "response_done", usage } : { type: "response_done" });
        // The response-complete boundary a scheduled goAway reconnect waits for.
        this.maybeReestablish();
      }
    }

    const calls = msg.toolCall?.functionCalls;
    if (calls) {
      for (const call of calls) {
        const toolId = call.id ?? crypto.randomUUID();
        const toolName = call.name ?? "unknown";
        this.trackToolName(toolId, { name: toolName, providerId: call.id });
        this.stream.push({
          type: "tool_call",
          toolId,
          toolName,
          args: (call.args ?? {}) as Record<string, unknown>,
        });
      }
    }
  }
}

/**
 * Parse Gemini's protobuf-duration `timeLeft` string (e.g. `"50s"`, `"3.5s"`) into
 * milliseconds. Absent or unparseable => `undefined`, meaning "reconnect now".
 */
function parseGoAwayTimeLeftMs(timeLeft: string | undefined): number | undefined {
  if (timeLeft === undefined) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)s$/.exec(timeLeft.trim());
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** Map Gemini's `usageMetadata` onto `RealtimeUsage`, omitting fields the provider omitted. */
function toRealtimeUsage(usage: UsageMetadata): RealtimeUsage | undefined {
  const out: RealtimeUsage = {
    ...(usage.promptTokenCount !== undefined ? { inputTokens: usage.promptTokenCount } : {}),
    ...(usage.responseTokenCount !== undefined ? { outputTokens: usage.responseTokenCount } : {}),
    ...(usage.totalTokenCount !== undefined ? { totalTokens: usage.totalTokenCount } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `startUserActivity` is Gemini-specific (manual-activity-detection mode) and not part of the
 * shared `RealtimeAdapter` interface — wiring a host-side speech-start signal to it is future
 * work (see task non-goals); this widened return type only makes the method reachable and
 * testable now. `injectToolResult`'s `scheduling`/`willContinue` options live on the shared
 * interface itself (every other adapter's fewer-parameter implementation still satisfies it),
 * so they need no widening here.
 */
export function fromGeminiLive(
  opts: GeminiLiveOptions,
): RealtimeAdapter & {
  startUserActivity(): void;
} {
  return new GeminiLiveAdapter(opts);
}
