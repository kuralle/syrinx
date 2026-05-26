// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Google Cloud Speech-to-Text Plugin
//
// Uses Google Cloud Speech-to-Text v2 REST API for streaming recognition.
// Sends audio chunks, receives interim and final transcripts.
// Pushes SttInterimPacket, SttResultPacket, and SttErrorPacket into the bus.
//
// Reference: Rapida transformer/google/stt.go (GCP Speech-to-Text v2 API)
// Reference: https://cloud.google.com/speech-to-text/v2/docs/streaming-recognize
//
// Unlike Deepgram which uses simple API keys, GCP requires:
//   - API key (for public API) OR
//   - Service account key (for private/project-scoped API)
//   - Project ID (required for recognizer path)

import type { PipelineBus } from "@asyncdot/voice";
import {
  Route,
  type VoicePlugin,
  type PluginConfig,
  requireStringConfig,
  optionalStringConfig,
  categorizeSttError,
  isRecoverable,
  readRetryConfig,
  waitForRetryDelay,
  type RetryConfig,
} from "@asyncdot/voice";

// =============================================================================
// Types
// =============================================================================

interface GCPConfig {
  recognizer: string;
  encoding: string;
  sampleRateHertz: number;
  languageCodes: string[];
  model: string;
  enableAutomaticPunctuation: boolean;
  interimResults: boolean;
}

// =============================================================================
// Plugin
// =============================================================================

export class GoogleSTTPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private apiKey: string = "";
  private projectId: string = "";
  private languageCode: string = "en-US";
  private model: string = "latest_long";
  private endpointUrl: string | undefined;
  private abortController: AbortController | null = null;
  private webSocket: import("ws").WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;
  private connRejecter: ((err: Error) => void) | null = null;
  private currentContextId = "";
  private disposers: Array<() => void> = [];
  private recognizerPath = "";
  private closed = false;
  private reconnecting = false;
  private retryConfig: RetryConfig = readRetryConfig({});

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.projectId = requireStringConfig(config, "project_id");
    this.languageCode = optionalStringConfig(config, "language") ?? "en-US";
    this.model = optionalStringConfig(config, "model") ?? "latest_long";
    this.endpointUrl = optionalStringConfig(config, "endpoint_url");
    this.retryConfig = readRetryConfig(config);
    this.abortController = new AbortController();
    this.closed = false;

    this.recognizerPath = `projects/${this.projectId}/locations/global/recognizers/_`;
    await this.connectWithRetry();

    // Listen for STT audio on the bus
    this.disposers.push(
      bus.on("stt.audio", async (pkt: unknown) => {
        const audioPkt = pkt as { audio: Uint8Array; contextId?: string };
        this.currentContextId = audioPkt.contextId ?? this.currentContextId;
        await this.sendAudio(audioPkt.audio);
      }),
      bus.on("turn.change", (pkt: unknown) => {
        this.currentContextId = (pkt as { contextId: string }).contextId;
      }),
    );
  }

  async sendAudio(audio: Uint8Array): Promise<void> {
    await this.waitUntilReady();
    const ws = this.webSocket;
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new Error("Google STT WebSocket is not open");
    }
    ws.send(audio);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortController?.abort();
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.webSocket) {
      this.webSocket.close();
      this.webSocket = null;
    }
    this.bus = null;
    this.ready = false;
    this.connResolver = null;
    this.connRejecter = null;
  }

  private async connectWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      try {
        await this.connect();
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const category = categorizeSttError(error);
        const recoverable = isRecoverable(category);
        this.emitError(error, recoverable ? category : category);
        if (!recoverable || attempt >= this.retryConfig.maxAttempts || this.closed) {
          throw error;
        }
        this.emitRetryMetric(attempt, category);
        await waitForRetryDelay(attempt, this.retryConfig, this.abortController?.signal);
      }
    }
  }

  private async connect(): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const url = this.endpointUrl ??
      `wss://speech.googleapis.com/v2/${this.recognizerPath}:streamingRecognize?key=${this.apiKey}`;
    const ws = new WebSocket(url);
    this.webSocket = ws;
    this.ready = false;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Google STT WebSocket connect timeout"));
      }, 10_000);

      ws.once("open", () => {
        clearTimeout(timeout);
        this.ready = true;
        this.sendConfig();
        this.connResolver?.();
        this.connResolver = null;
        this.connRejecter = null;
        resolve();
      });

      ws.once("error", (err: Error) => {
        clearTimeout(timeout);
        this.ready = false;
        reject(err);
      });
    });

    ws.on("message", (data: import("ws").RawData) => {
      this.handleMessage(data);
    });

    ws.on("error", (err: Error) => {
      this.ready = false;
      this.connRejecter?.(err);
      this.connResolver = null;
      this.connRejecter = null;
      const category = categorizeSttError(err);
      this.emitError(err, category);
      if (isRecoverable(category)) {
        void this.reconnect();
      }
    });

    ws.on("close", () => {
      this.ready = false;
      this.connRejecter?.(new Error("Google STT WebSocket closed before ready"));
      this.connResolver = null;
      this.connRejecter = null;
      if (!this.closed && !this.reconnecting) {
        void this.reconnect();
      }
    });
  }

  private sendConfig(): void {
    const configMsg = {
      recognizer: this.recognizerPath,
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: 16000,
            audioChannelCount: 1,
          },
          languageCodes: [this.languageCode],
          model: this.model,
          features: {
            enableAutomaticPunctuation: true,
            enableWordConfidence: true,
          },
        },
        streamingFeatures: {
          interimResults: true,
        },
      },
    };
    this.webSocket?.send(JSON.stringify(configMsg));
  }

  private handleMessage(data: import("ws").RawData): void {
    try {
      const msg = JSON.parse(data.toString());
      const results = msg.results;
      if (!Array.isArray(results) || results.length === 0) return;

      for (const result of results) {
        const alt = result.alternatives?.[0];
        if (!alt?.transcript) continue;

        const text = String(alt.transcript).trim();
        if (!text) continue;
        const confidence = alt.confidence ?? 0;

        if (result.isFinal === true) {
          this.bus?.push(Route.Main, {
            kind: "stt.result",
            contextId: this.currentContextId,
            timestampMs: Date.now(),
            text,
            confidence,
            language: this.languageCode,
          });
          this.bus?.push(Route.Main, {
            kind: "eos.turn_complete",
            contextId: this.currentContextId,
            timestampMs: Date.now(),
            text,
            transcripts: [],
          });
        } else {
          this.bus?.push(Route.Main, {
            kind: "stt.interim",
            contextId: this.currentContextId,
            timestampMs: Date.now(),
            text,
          });
        }
      }
    } catch {
      // Provider keepalives or malformed transient messages are ignored.
    }
  }

  private async waitUntilReady(): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Google STT WebSocket connect timeout"));
      }, 10_000);
      this.connResolver = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.connRejecter = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    });
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.webSocket?.close();
    } catch {
      // best effort
    }
    try {
      await this.connectWithRetry();
    } catch {
      // stt.error already emitted; session error policy handles fatal state.
    } finally {
      this.reconnecting = false;
    }
  }

  private emitError(error: Error, category = categorizeSttError(error)): void {
    this.bus?.push(Route.Critical, {
      kind: "stt.error",
      contextId: this.currentContextId,
      timestampMs: Date.now(),
      component: "stt" as const,
      category,
      cause: error,
      isRecoverable: isRecoverable(category),
    });
  }

  private emitRetryMetric(attempt: number, category: string): void {
    this.bus?.push(Route.Background, {
      kind: "metric.conversation",
      contextId: this.currentContextId,
      timestampMs: Date.now(),
      name: "stt.retry",
      value: `google:${category}:${attempt}`,
    });
  }
}
