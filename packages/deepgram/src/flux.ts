// SPDX-License-Identifier: MIT
//
// Deepgram Flux — turn-aware conversational STT (v2 listen API).
//
// One model produces transcripts AND owns turn detection, replacing the
// VAD + silence-endpointing stack. Runs on Workers (plain WebSocket), so this
// is the semantic end-of-turn path for the edge cascade, where local ONNX
// endpointers (smart-turn) cannot run.
//
// TurnInfo state machine → bus mapping (via stt-core SttEvent):
//   StartOfTurn     → vad.speech_started   (barge-in signal; Flux recommends it)
//   Update          → stt.interim
//   EagerEndOfTurn  → eos.interim          (speculative-generation trigger)
//   TurnResumed     → eos.retracted        (cancel speculative work)
//   EndOfTurn       → stt.result + eos.turn_complete
//
// Eager mode is enabled by setting `eager_eot_threshold` (Deepgram: fires
// 150–250ms before EndOfTurn at the cost of extra speculative LLM calls). The
// EndOfTurn transcript exactly matches the preceding EagerEndOfTurn transcript
// when no TurnResumed intervened, so a speculative result keyed on the eager
// transcript can be committed as-is.

import {
  Route,
  categorizeSttError,
  isRecoverable,
  type AudioFormat,
  type PipelineBus,
  type PluginConfig,
  type SttErrorPacket,
  type SttReconfigure,
  type SttReconfigurePartial,
  type VoicePlugin,
  optionalStringConfig,
  readProviderRetryConfig,
  requireStringConfig,
} from "@kuralle-syrinx/core";
import {
  defaultNodeSocketFactory,
  startStreamingSttSession,
  type SttEvent,
  type SttWireProtocol,
  type StreamingSttSession,
} from "@kuralle-syrinx/stt-core";
import type { SocketData, SocketFactory } from "@kuralle-syrinx/ws";

interface TurnInfoMessage {
  readonly type: "TurnInfo";
  readonly event: "StartOfTurn" | "Update" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";
  readonly transcript?: string;
  readonly words?: ReadonlyArray<{ readonly word: string; readonly confidence: number }>;
  readonly end_of_turn_confidence?: number;
}

function meanWordConfidence(words: TurnInfoMessage["words"]): number {
  if (!words || words.length === 0) return 1;
  let sum = 0;
  for (const w of words) sum += w.confidence;
  return sum / words.length;
}

type MetricSink = (name: string, value: string) => void;

class DeepgramFluxSttWireProtocol implements SttWireProtocol {
  constructor(
    private readonly speechStartedEvents: boolean,
    private readonly onMetric: MetricSink,
  ) {}

  encodeFinalize(_contextId: string): readonly SocketData[] {
    return [];
  }

  encodeClose(): readonly SocketData[] {
    return [JSON.stringify({ type: "CloseStream" })];
  }

  encodeReconfigure(partial: SttReconfigurePartial): readonly SocketData[] {
    const thresholds: Record<string, number> = {};
    if (partial.eotThreshold !== undefined) thresholds["eot_threshold"] = partial.eotThreshold;
    if (partial.eagerEotThreshold !== undefined) {
      thresholds["eager_eot_threshold"] = partial.eagerEotThreshold;
    }
    if (partial.eotTimeoutMs !== undefined) thresholds["eot_timeout_ms"] = partial.eotTimeoutMs;

    const configure: Record<string, unknown> = { type: "Configure" };
    if (Object.keys(thresholds).length > 0) configure["thresholds"] = thresholds;
    if (partial.keyterms !== undefined) configure["keyterms"] = partial.keyterms;
    if (partial.languageHints !== undefined) configure["language_hints"] = partial.languageHints;

    return [JSON.stringify(configure)];
  }

  decode(data: SocketData, _isBinary: boolean): readonly SttEvent[] {
    if (typeof data !== "string") return [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      return [
        {
          type: "error",
          error: new Error(
            `Deepgram Flux sent malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
          ),
        },
      ];
    }

    if (msg["type"] === "Error") {
      const description =
        typeof msg["description"] === "string" ? msg["description"] : JSON.stringify(msg);
      return [
        {
          type: "error",
          error: new Error(`Deepgram Flux provider error: ${description}`),
        },
      ];
    }
    // Ack/nack for a mid-stream Configure (dynamic reconfigure). Surface as metrics so the
    // conversation-state biasing that actuates reconfigure can observe that it took effect.
    if (msg["type"] === "ConfigureSuccess") {
      this.onMetric("stt.flux.configure_success", "1");
      return [];
    }
    if (msg["type"] === "ConfigureFailure") {
      const description =
        typeof msg["description"] === "string" ? msg["description"] : JSON.stringify(msg);
      this.onMetric("stt.flux.configure_failure", description);
      return [];
    }
    if (msg["type"] !== "TurnInfo") return [];

    const info = msg as unknown as TurnInfoMessage;
    const transcript = (info.transcript ?? "").trim();

    switch (info.event) {
      case "StartOfTurn":
        if (!this.speechStartedEvents) return [];
        return [{ type: "speech_started" }];
      case "Update":
        if (!transcript) return [];
        return [{ type: "interim", contextId: "", text: transcript }];
      case "EagerEndOfTurn":
        if (!transcript) return [];
        return [{ type: "eos_interim", text: transcript }];
      case "TurnResumed":
        return [{ type: "eos_retracted" }];
      case "EndOfTurn":
        if (!transcript) return [];
        return [
          {
            type: "final",
            contextId: "",
            text: transcript,
            confidence: meanWordConfidence(info.words),
            language: "en",
            speechFinal: true,
          },
        ];
      default:
        return [];
    }
  }
}

export class DeepgramFluxSTTPlugin implements VoicePlugin {
  readonly endpointingCapability = {
    owner: "provider_stt" as const,
    disableConfig: {
      emit_eos_on_final: false,
    },
  };

  private bus: PipelineBus | null = null;
  private session: StreamingSttSession | null = null;
  private model = "flux-general-en";
  private endpointUrl = "wss://api.deepgram.com/v2/listen";
  private sampleRate = 16000;
  private eotThreshold = 0.7;
  private eagerEotThreshold: number | undefined;
  private eotTimeoutMs = 5000;
  private keyterms: readonly string[] = [];
  private languageHints: readonly string[] = [];
  private speechStartedEvents = true;
  private encoding = "linear16";
  /** Open-ended Flux listen query knobs (profanity_filter, tag, mip_opt_out, …). */
  private queryParams: Record<string, unknown> | undefined;
  private apiKey = "";
  private currentContextId = "";

  constructor(private readonly socketFactory?: SocketFactory) {}

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.model = optionalStringConfig(config, "model") ?? "flux-general-en";
    this.endpointUrl = optionalStringConfig(config, "endpoint_url") ?? "wss://api.deepgram.com/v2/listen";
    this.sampleRate = (config["sample_rate"] as number) ?? 16000;
    this.eotThreshold = (config["eot_threshold"] as number) ?? 0.7;
    this.eagerEotThreshold = config["eager_eot_threshold"] as number | undefined;
    this.eotTimeoutMs = (config["eot_timeout_ms"] as number) ?? 5000;
    this.speechStartedEvents = (config["speech_started_events"] as boolean) ?? true;
    const emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;
    {
      const raw = config["keyterm"];
      this.keyterms = Array.isArray(raw)
        ? raw.filter((t): t is string => typeof t === "string" && t.length > 0)
        : typeof raw === "string" && raw.length > 0
          ? [raw]
          : [];
    }
    {
      const raw = config["language_hint"];
      this.languageHints = Array.isArray(raw)
        ? raw.filter((t): t is string => typeof t === "string" && t.length > 0)
        : typeof raw === "string" && raw.length > 0
          ? [raw]
          : [];
    }
    this.encoding = optionalStringConfig(config, "encoding") ?? "linear16";
    this.queryParams = readPlainObject(config["query_params"]);

    const audioFormat: AudioFormat = {
      encoding: "pcm_s16le",
      sampleRateHz: this.sampleRate,
      channels: 1,
    };

    this.session = await startStreamingSttSession(bus, {
      protocol: new DeepgramFluxSttWireProtocol(this.speechStartedEvents, (name, value) => {
        bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId: "",
          timestampMs: Date.now(),
          name,
          value,
        });
      }),
      provider: { name: "deepgram", model: this.model, region: "global" },
      format: audioFormat,
      language: "en",
      emitEosOnFinal,
      url: () => {
        const params = new URLSearchParams({
          model: this.model,
          encoding: this.encoding,
          sample_rate: String(this.sampleRate),
          eot_threshold: String(this.eotThreshold),
          eot_timeout_ms: String(this.eotTimeoutMs),
          ...(this.eagerEotThreshold !== undefined
            ? { eager_eot_threshold: String(this.eagerEotThreshold) }
            : {}),
        });
        for (const term of this.keyterms) params.append("keyterm", term);
        for (const hint of this.languageHints) params.append("language_hint", hint);
        applyQueryParams(params, this.queryParams);
        const separator = this.endpointUrl.includes("?") ? "&" : "?";
        return `${this.endpointUrl}${separator}${params.toString()}`;
      },
      headers: { Authorization: `Token ${this.apiKey}` },
      socketFactory: this.socketFactory ?? (await defaultNodeSocketFactory()),
      retry: readProviderRetryConfig(config),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 64,
      metricPrefix: "stt.flux",
    });
  }

  /**
   * Mid-stream reconfigure of keyterms / end-of-turn thresholds via the Flux v2 `Configure`
   * control message — no socket restart (Deepgram "on-the-fly configuration"). Instance state is
   * updated too, so a reconnect replays the current config (single source of truth with `url()`).
   * `keyterms` REPLACES the list (Flux semantics), not merges. The provider acks with
   * ConfigureSuccess / ConfigureFailure (surfaced as metrics in the wire protocol).
   */
  get sttReconfigure(): SttReconfigure {
    return this;
  }

  reconfigure(partial: SttReconfigurePartial): void {
    if (partial.keyterms !== undefined) this.keyterms = partial.keyterms;
    if (partial.eotThreshold !== undefined) this.eotThreshold = partial.eotThreshold;
    if (partial.eagerEotThreshold !== undefined) this.eagerEotThreshold = partial.eagerEotThreshold;
    if (partial.eotTimeoutMs !== undefined) this.eotTimeoutMs = partial.eotTimeoutMs;
    if (partial.languageHints !== undefined) this.languageHints = partial.languageHints;

    try {
      this.session?.reconfigure(partial);
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private emitError(err: Error): void {
    const category = categorizeSttError(err);
    const packet: SttErrorPacket = {
      kind: "stt.error",
      contextId: this.currentContextId,
      timestampMs: Date.now(),
      component: "stt",
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.bus?.push(Route.Critical, packet);
  }

  async close(): Promise<void> {
    await this.session?.dispose();
    this.session = null;
    this.bus = null;
  }
}

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function applyQueryParams(params: URLSearchParams, extra: Record<string, unknown> | undefined): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.set(key, String(value));
  }
}
