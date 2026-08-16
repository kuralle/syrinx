// SPDX-License-Identifier: MIT

import type { GoogleGenAI, LiveCallbacks, Session, LiveServerMessage } from "@google/genai";

import { bytesToBase64, base64ToBytes } from "./base64.js";
import { RealtimeEventStream } from "./realtime-event-stream.js";
import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef } from "./realtime-adapter.js";

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
  private session: Session | null = null;
  private abortHandler: (() => void) | null = null;
  private openResolver: (() => void) | null = null;
  private openRejecter: ((err: Error) => void) | null = null;
  private activeResponse = false;
  private readonly toolNames = new Map<string, { name: string; providerId: string | undefined }>();
  /** Bumped on every (re)connect; callbacks captured from a retired session no-op once stale. */
  private generation = 0;
  private closed = false;
  private latestResumptionHandle: string | undefined;
  private goAwayDeadlineAtMs: number | undefined;
  private reestablishing = false;
  private hardCutoffTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: GeminiLiveOptions) {
    this.events = this.stream;
    this.latestResumptionHandle = opts.sessionResumptionHandle;
  }

  async open(signal: AbortSignal): Promise<void> {
    const { GoogleGenAI, Modality } = await import("@google/genai");
    this.model = this.opts.model ?? DEFAULT_MODEL;
    this.audioModality = Modality.AUDIO;

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
    if (this.opts.realtimeInputConfig !== undefined) {
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

  injectToolResult(toolId: string, text: string): void {
    const entry = this.toolNames.get(toolId);
    if (!entry) {
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
        response: { result: text },
      }],
    });
    this.toolNames.delete(toolId);
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

  private requireSession(): Session {
    if (!this.session) throw new Error("Gemini Live adapter is not open");
    return this.session;
  }

  private requireAi(): GoogleGenAI {
    if (!this.ai) throw new Error("Gemini Live adapter is not open");
    return this.ai;
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

    if (msg.setupComplete) {
      if (!this.activeResponse) {
        this.activeResponse = true;
        this.stream.push({ type: "response_started" });
      }
    }

    const content = msg.serverContent;
    if (content) {
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
        this.stream.push({ type: "response_done" });
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

export function fromGeminiLive(opts: GeminiLiveOptions): RealtimeAdapter {
  return new GeminiLiveAdapter(opts);
}
