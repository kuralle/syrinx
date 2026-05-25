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
  private abortController: AbortController | null = null;
  private webSocket: WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.projectId = requireStringConfig(config, "project_id");
    this.languageCode = optionalStringConfig(config, "language") ?? "en-US";
    this.model = optionalStringConfig(config, "model") ?? "latest_long";

    // GCP STT uses WebSocket: wss://speech.googleapis.com/v2/projects/{project}/locations/global/recognizers/_/stream
    const recognizerPath = `projects/${this.projectId}/locations/global/recognizers/_`;
    const url = `wss://speech.googleapis.com/v2/${recognizerPath}:streamingRecognize?key=${this.apiKey}`;

    this.webSocket = new WebSocket(url);
    this.webSocket.binaryType = "arraybuffer";

    this.webSocket.onopen = () => {
      this.ready = true;

      // Send initial StreamingRecognizeRequest with config
      const configMsg = {
        recognizer: recognizerPath,
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

      this.webSocket!.send(JSON.stringify(configMsg));
      this.connResolver?.();
    };

    this.webSocket.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer)),
        );

        // GCP returns a StreamingRecognizeResponse
        const results = msg.results;
        if (!results || results.length === 0) return;

        for (const result of results) {
          const alt = result.alternatives?.[0];
          if (!alt?.transcript) continue;

          const isFinal = result.isFinal === true;
          const confidence = alt.confidence ?? 0;

          if (isFinal) {
            this.bus?.push(Route.Main, {
              kind: "stt.result",
              contextId: "",
              timestampMs: Date.now(),
              text: alt.transcript.trim(),
              confidence,
              language: this.languageCode,
            });

            // Also emit EOS turn complete
            this.bus?.push(Route.Main, {
              kind: "eos.turn_complete",
              contextId: "",
              timestampMs: Date.now(),
              text: alt.transcript.trim(),
              transcripts: [],
            });
          } else {
            this.bus?.push(Route.Main, {
              kind: "stt.interim",
              contextId: "",
              timestampMs: Date.now(),
              text: alt.transcript.trim(),
            });
          }
        }
      } catch {
        // Parse errors are non-critical
      }
    };

    this.webSocket.onerror = (err: Event) => {
      const error = new Error(`Google STT WebSocket error: ${err.type}`);
      const category = categorizeSttError(error);
      this.bus?.push(Route.Critical, {
        kind: "stt.error",
        contextId: "",
        timestampMs: Date.now(),
        component: "stt" as const,
        category,
        cause: error,
        isRecoverable: isRecoverable(category),
      });
    };

    // Listen for STT audio on the bus
    bus.on("stt.audio", async (pkt: unknown) => {
      const audioPkt = pkt as { audio: Uint8Array };
      await this.sendAudio(audioPkt.audio);
    });
  }

  async sendAudio(audio: Uint8Array): Promise<void> {
    if (!this.ready) {
      await new Promise<void>((r) => {
        this.connResolver = r;
      });
    }
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(audio);
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    if (this.webSocket) {
      this.webSocket.close();
      this.webSocket = null;
    }
    this.bus = null;
  }
}
