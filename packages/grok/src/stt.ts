// SPDX-License-Identifier: MIT

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  Route,
  type AudioFormat,
  type PluginConfig,
  type SttErrorPacket,
  type VoicePlugin,
  assertAudioFormat,
  assertAudioPayload,
  categorizeSttError,
  isRecoverable,
  optionalStringConfig,
  readProviderRetryConfig,
  requireStringConfig,
} from "@kuralle-syrinx/core";
import { WebSocketConnection, type SocketFactory } from "@kuralle-syrinx/ws";

const AUDIO_DONE = JSON.stringify({ type: "audio.done" });

export class GrokSTTPlugin implements VoicePlugin {
  readonly endpointingCapability = {
    owner: "provider_stt" as const,
    disableConfig: {
      emit_eos_on_final: false,
      finalize_on_speech_final: false,
    },
  };

  constructor(private readonly socketFactory?: SocketFactory) {}

  private bus: PipelineBus | null = null;
  private conn: WebSocketConnection | null = null;
  private apiKey = "";
  private sampleRate = 16000;
  private language = "en";
  private endpointUrl = "wss://api.x.ai/v1/stt";
  private encoding = "pcm";
  private interimResults = true;
  private endpointing = 10;
  private smartTurn: number | undefined;
  private smartTurnTimeoutMs: number | undefined;
  private diarize = false;
  private keyterm: string | undefined;
  private emitEosOnFinal = true;
  private audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };
  private currentContextId = "";
  private transcriptReady = false;
  private disposers: Array<() => void> = [];

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.sampleRate = (config["sample_rate"] as number) ?? 16000;
    this.language = optionalStringConfig(config, "language") ?? "en";
    this.endpointUrl = optionalStringConfig(config, "endpoint_url") ?? this.endpointUrl;
    this.encoding = optionalStringConfig(config, "encoding") ?? this.encoding;
    this.interimResults = (config["interim_results"] as boolean) ?? true;
    this.endpointing = (config["endpointing"] as number) ?? 10;
    this.smartTurn = typeof config["smart_turn"] === "number" ? config["smart_turn"] : undefined;
    this.smartTurnTimeoutMs =
      typeof config["smart_turn_timeout"] === "number" ? config["smart_turn_timeout"] : undefined;
    this.diarize = (config["diarize"] as boolean) ?? false;
    this.keyterm = optionalStringConfig(config, "keyterm");
    this.emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;
    this.audioFormat = { encoding: "pcm_s16le", sampleRateHz: this.sampleRate, channels: 1 };
    assertAudioFormat(this.audioFormat);

    this.conn = new WebSocketConnection({
      url: () => {
        const params = new URLSearchParams({
          sample_rate: String(this.sampleRate),
          encoding: this.encoding,
          interim_results: String(this.interimResults),
          language: this.language,
          endpointing: String(this.endpointing),
        });
        if (this.smartTurn !== undefined) params.set("smart_turn", String(this.smartTurn));
        if (this.smartTurnTimeoutMs !== undefined) {
          params.set("smart_turn_timeout", String(this.smartTurnTimeoutMs));
        }
        if (this.diarize) params.set("diarize", "true");
        if (this.keyterm) params.set("keyterm", this.keyterm);
        const separator = this.endpointUrl.includes("?") ? "&" : "?";
        return `${this.endpointUrl}${separator}${params.toString()}`;
      },
      headers: { Authorization: `Bearer ${this.apiKey}` },
      socketFactory: this.socketFactory ?? (await defaultSocketFactory()),
      retry: readProviderRetryConfig(config),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 64,
      onMessage: (data) => {
        if (typeof data === "string") this.handleProviderMessage(data);
      },
      onConnectionLost: (err) => {
        this.transcriptReady = false;
        this.emitError(this.currentContextId, err);
      },
    });
    await this.conn.connect();

    this.disposers.push(
      bus.on("stt.audio", (pkt: unknown) => {
        void this.handleAudioPacket(pkt as { audio: Uint8Array; contextId?: string });
      }),
      bus.on("user.audio_received", (pkt: unknown) => {
        void this.handleAudioPacket(pkt as { audio: Uint8Array; contextId?: string });
      }),
      bus.on("turn.change", (pkt: unknown) => {
        this.currentContextId = (pkt as { contextId: string }).contextId;
      }),
      bus.on("interrupt.stt", () => {
        this.currentContextId = "";
      }),
      bus.on("stt.finalize", () => {
        void this.sendAudioDone();
      }),
    );
  }

  private async handleAudioPacket(pkt: { audio: Uint8Array; contextId?: string }): Promise<void> {
    if (pkt.contextId) this.currentContextId = pkt.contextId;
    await this.sendAudio(pkt.audio, this.currentContextId);
  }

  async sendAudio(audio: Uint8Array, contextId = this.currentContextId): Promise<boolean> {
    if (audio.byteLength === 0) return true;
    try {
      assertAudioPayload(this.audioFormat, audio);
      if (!this.conn) throw new Error("Grok STT is not connected");
      await this.conn.ensureReady();
      if (!this.transcriptReady) return false;
      this.conn.send(audio);
      return true;
    } catch (err) {
      this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  private async sendAudioDone(): Promise<void> {
    try {
      await this.conn?.ensureReady();
      if (this.conn?.isReady) this.conn.send(AUDIO_DONE);
    } catch (err) {
      this.emitError(this.currentContextId, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleProviderMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      this.emitError(
        this.currentContextId,
        new Error(`Grok STT provider sent malformed JSON: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    const type = typeof msg["type"] === "string" ? msg["type"] : "";
    switch (type) {
      case "transcript.created":
        this.transcriptReady = true;
        return;
      case "transcript.partial":
        this.handleTranscriptPartial(msg);
        return;
      case "transcript.done":
        return;
      case "error":
        this.emitError(
          this.currentContextId,
          new Error(typeof msg["message"] === "string" ? msg["message"] : "Grok STT provider error"),
        );
        return;
      default:
        return;
    }
  }

  private handleTranscriptPartial(msg: Record<string, unknown>): void {
    const text = typeof msg["text"] === "string" ? msg["text"].trim() : "";
    if (!text) return;

    const isFinal = msg["is_final"] === true;
    const speechFinal = msg["speech_final"] === true;
    const confidence =
      typeof msg["end_of_turn_confidence"] === "number" ? msg["end_of_turn_confidence"] : 0;
    const provider: Record<string, unknown> = {
      name: "grok",
      model: "stt",
      region: "global",
      speechFinal,
      words: msg["words"],
      start: msg["start"],
      duration: msg["duration"],
    };

    if (isFinal) {
      this.bus?.push(Route.Main, {
        kind: "stt.result",
        contextId: this.currentContextId,
        timestampMs: Date.now(),
        text,
        confidence,
        language: this.language,
        provider,
      });
      if (this.emitEosOnFinal && speechFinal) {
        this.bus?.push(Route.Main, {
          kind: "eos.turn_complete",
          contextId: this.currentContextId,
          timestampMs: Date.now(),
          text,
          transcripts: [],
        });
      }
      return;
    }

    this.bus?.push(Route.Main, {
      kind: "stt.interim",
      contextId: this.currentContextId,
      timestampMs: Date.now(),
      text,
    });
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeSttError(err);
    const packet: SttErrorPacket = {
      kind: "stt.error",
      contextId,
      timestampMs: Date.now(),
      component: "stt",
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.bus?.push(Route.Critical, packet);
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.conn?.isReady) {
      try {
        this.conn.send(AUDIO_DONE);
      } catch {
        // best effort
      }
    }
    await this.conn?.close();
    this.conn = null;
    this.bus = null;
    this.transcriptReady = false;
  }
}

async function defaultSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@kuralle-syrinx/ws/node");
  return mod.createNodeWsSocket;
}
