// SPDX-License-Identifier: MIT
//
// Deepgram Flux — turn-aware conversational STT (v2 listen API).
//
// One model produces transcripts AND owns turn detection, replacing the
// VAD + silence-endpointing stack. Runs on Workers (plain WebSocket), so this
// is the semantic end-of-turn path for the edge cascade, where local ONNX
// endpointers (smart-turn) cannot run.
//
// TurnInfo state machine → bus mapping:
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

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  Route,
  type PluginConfig,
  type SttErrorPacket,
  type VoicePlugin,
  categorizeSttError,
  isRecoverable,
  optionalStringConfig,
  readProviderRetryConfig,
  requireStringConfig,
} from "@kuralle-syrinx/core";
import { WebSocketConnection, type SocketFactory } from "@kuralle-syrinx/ws";

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

export class DeepgramFluxSTTPlugin implements VoicePlugin {
  readonly endpointingCapability = {
    owner: "provider_stt" as const,
    disableConfig: {
      emit_eos_on_final: false,
    },
  };

  private bus: PipelineBus | null = null;
  private apiKey = "";
  private model = "flux-general-en";
  private endpointUrl = "wss://api.deepgram.com/v2/listen";
  private sampleRate = 16000;
  private eotThreshold = 0.7;
  private eagerEotThreshold: number | undefined;
  private eotTimeoutMs = 5000;
  private keyterms: readonly string[] = [];
  private languageHints: readonly string[] = [];
  private speechStartedEvents = true;
  private emitEosOnFinal = true;

  private conn: WebSocketConnection | null = null;
  private currentContextId = "";
  private disposers: Array<() => void> = [];

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
    this.emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;
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

    const socketFactory = this.socketFactory ?? (await defaultSocketFactory());
    this.conn = new WebSocketConnection({
      url: () => {
        const params = new URLSearchParams({
          model: this.model,
          encoding: "linear16",
          sample_rate: String(this.sampleRate),
          eot_threshold: String(this.eotThreshold),
          eot_timeout_ms: String(this.eotTimeoutMs),
          ...(this.eagerEotThreshold !== undefined
            ? { eager_eot_threshold: String(this.eagerEotThreshold) }
            : {}),
        });
        for (const term of this.keyterms) params.append("keyterm", term);
        for (const hint of this.languageHints) params.append("language_hint", hint);
        const separator = this.endpointUrl.includes("?") ? "&" : "?";
        return `${this.endpointUrl}${separator}${params.toString()}`;
      },
      headers: { Authorization: `Token ${this.apiKey}` },
      socketFactory,
      retry: readProviderRetryConfig(config),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 64,
      onReplay: (event, count) => {
        this.pushMetric(this.currentContextId, `stt.flux.reconnect_replay_${event}`, String(count));
      },
      // No provider keepalive text message: the Flux v2 protocol keeps the turn
      // model fed by continuous audio; transports stream silence frames between
      // utterances, so an idle socket means the call itself has gone quiet.
      onMessage: (data) => {
        if (typeof data === "string") this.handleProviderMessage(data);
      },
      onConnectionLost: (err) => {
        this.emitError(this.currentContextId, err);
      },
    });
    await this.conn.connect();

    this.disposers.push(
      bus.on("stt.audio", async (pkt: unknown) => {
        const audioPkt = pkt as { audio: Uint8Array; contextId?: string };
        if (audioPkt.contextId) this.currentContextId = audioPkt.contextId;
        if (!this.conn) return;
        try {
          await this.conn.ensureReady();
          this.conn.send(audioPkt.audio);
        } catch (err) {
          this.emitError(this.currentContextId, err instanceof Error ? err : new Error(String(err)));
        }
      }),
      bus.on("turn.change", (pkt: unknown) => {
        const tc = pkt as { contextId: string };
        this.currentContextId = tc.contextId;
      }),
    );
  }

  private handleProviderMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      this.emitError(
        this.currentContextId,
        new Error(`Deepgram Flux sent malformed JSON: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    if (msg["type"] === "Error") {
      const description = typeof msg["description"] === "string" ? msg["description"] : JSON.stringify(msg);
      this.emitError(this.currentContextId, new Error(`Deepgram Flux provider error: ${description}`));
      return;
    }
    if (msg["type"] !== "TurnInfo") return;

    const info = msg as unknown as TurnInfoMessage;
    const contextId = this.currentContextId;
    const transcript = (info.transcript ?? "").trim();

    switch (info.event) {
      case "StartOfTurn": {
        if (!this.speechStartedEvents) return;
        this.bus?.push(Route.Main, {
          kind: "vad.speech_started",
          contextId,
          timestampMs: Date.now(),
          confidence: 1,
        });
        return;
      }
      case "Update": {
        if (!transcript) return;
        this.bus?.push(Route.Main, {
          kind: "stt.interim",
          contextId,
          timestampMs: Date.now(),
          text: transcript,
        });
        return;
      }
      case "EagerEndOfTurn": {
        if (!transcript) return;
        this.bus?.push(Route.Main, {
          kind: "eos.interim",
          contextId,
          timestampMs: Date.now(),
          text: transcript,
        });
        return;
      }
      case "TurnResumed": {
        this.bus?.push(Route.Main, {
          kind: "eos.retracted",
          contextId,
          timestampMs: Date.now(),
        });
        return;
      }
      case "EndOfTurn": {
        if (!transcript) return;
        this.bus?.push(Route.Main, {
          kind: "stt.result",
          contextId,
          timestampMs: Date.now(),
          text: transcript,
          confidence: meanWordConfidence(info.words),
          language: "en",
          provider: { name: "deepgram", model: this.model, region: "global" },
        });
        if (this.emitEosOnFinal) {
          this.bus?.push(Route.Main, {
            kind: "eos.turn_complete",
            contextId,
            timestampMs: Date.now(),
            text: transcript,
            transcripts: [],
          });
        }
        return;
      }
    }
  }

  private pushMetric(contextId: string, name: string, value: string): void {
    this.bus?.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: Date.now(),
      name,
      value,
    });
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeSttError(err);
    const packet: SttErrorPacket = {
      kind: "stt.error",
      contextId,
      timestampMs: Date.now(),
      component: "stt" as const,
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.bus?.push(Route.Critical, packet);
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.conn) {
      if (this.conn.isReady) {
        try {
          this.conn.send(JSON.stringify({ type: "CloseStream" }));
        } catch {
          // Socket already going away — CloseStream is best-effort.
        }
      }
      await this.conn.close();
      this.conn = null;
    }
    this.bus = null;
  }
}

async function defaultSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@kuralle-syrinx/ws/node");
  return mod.createNodeWsSocket;
}
