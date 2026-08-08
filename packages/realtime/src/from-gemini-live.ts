// SPDX-License-Identifier: MIT

import type { Session, LiveServerMessage } from "@google/genai";

import { bytesToBase64, base64ToBytes } from "./base64.js";
import { RealtimeEventStream } from "./realtime-event-stream.js";
import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef } from "./realtime-adapter.js";

const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const INPUT_SAMPLE_RATE_HZ = 16_000;
const OUTPUT_SAMPLE_RATE_HZ = 24_000;
/** In-flight tool-call ids awaiting a client result. Oldest evicted at cap (iu-ledger pattern). */
const MAX_TOOL_NAMES = 256;

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
  private session: Session | null = null;
  private abortHandler: (() => void) | null = null;
  private openResolver: (() => void) | null = null;
  private openRejecter: ((err: Error) => void) | null = null;
  private activeResponse = false;
  private readonly toolNames = new Map<string, { name: string; providerId: string | undefined }>();

  constructor(private readonly opts: GeminiLiveOptions) {
    this.events = this.stream;
  }

  async open(signal: AbortSignal): Promise<void> {
    const { GoogleGenAI, Modality } = await import("@google/genai");
    const model = this.opts.model ?? DEFAULT_MODEL;

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
        : [Modality.AUDIO],
    };
    // G4: session resumption defaults ON so the server issues handles; a prior
    // handle resumes server-side (native resume — no replay). Override via
    // sessionResumption (full object) or disable with false.
    if (!("sessionResumption" in this.opts) || this.opts.sessionResumption !== false) {
      const base =
        typeof this.opts.sessionResumption === "object" && this.opts.sessionResumption !== null
          ? { ...this.opts.sessionResumption }
          : {};
      if (this.opts.sessionResumptionHandle !== undefined) {
        base["handle"] = this.opts.sessionResumptionHandle;
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

    const openPromise = new Promise<void>((resolve, reject) => {
      this.openResolver = resolve;
      this.openRejecter = reject;
    });

    const ai = new GoogleGenAI({
      apiKey: this.opts.apiKey,
      ...(this.opts.apiVersion === undefined
        ? {}
        : { httpOptions: { apiVersion: this.opts.apiVersion } }),
    });

    this.session = await ai.live.connect({
      model,
      config,
      callbacks: {
        onopen: () => this.resolveOpen(),
        onmessage: (msg) => this.handleMessage(msg),
        onerror: (ev) => {
          const cause = ev instanceof Error ? ev : new Error(String(ev));
          this.stream.push({ type: "error", cause, recoverable: true });
          this.rejectOpen(cause);
        },
        onclose: (ev) => {
          const reason =
            ev && typeof ev === "object" && "reason" in ev && typeof ev.reason === "string"
              ? ev.reason.trim()
              : "";
          if (reason) {
            this.stream.push({ type: "error", cause: new Error(reason), recoverable: false });
          }
          this.stream.close();
        },
      },
    });

    this.abortHandler = () => {
      void this.close();
      this.rejectOpen(new Error("Gemini Live adapter open aborted"));
    };
    signal.addEventListener("abort", this.abortHandler, { once: true });

    await openPromise;
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
    // G4: surface fresh resumption handles so a durable host can persist the latest.
    const resumption = msg.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      this.stream.push({ type: "resumption_handle", handle: resumption.newHandle });
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

export function fromGeminiLive(opts: GeminiLiveOptions): RealtimeAdapter {
  return new GeminiLiveAdapter(opts);
}
