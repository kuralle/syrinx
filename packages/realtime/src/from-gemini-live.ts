// SPDX-License-Identifier: MIT

import type { Session, LiveServerMessage } from "@google/genai";

import { bytesToBase64, base64ToBytes } from "./base64.js";
import { RealtimeEventStream } from "./realtime-event-stream.js";
import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef } from "./realtime-adapter.js";

const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const INPUT_SAMPLE_RATE_HZ = 16_000;
const OUTPUT_SAMPLE_RATE_HZ = 24_000;

export interface GeminiLiveOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly systemInstruction?: string;
  readonly tools?: readonly RealtimeToolDef[];
}

class GeminiLiveAdapter implements RealtimeAdapter {
  readonly caps = {
    inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    outputSampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
    supportsConcurrentToolAudio: false,
    supportsTruncate: false,
    emitsServerSpeechStarted: true,
  } as const;

  readonly events: AsyncIterable<RealtimeEvent>;

  private readonly stream = new RealtimeEventStream();
  private session: Session | null = null;
  private abortHandler: (() => void) | null = null;
  private openResolver: (() => void) | null = null;
  private openRejecter: ((err: Error) => void) | null = null;
  private activeResponse = false;
  private readonly toolNames = new Map<string, string>();

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

    const config: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (this.opts.systemInstruction) {
      config["systemInstruction"] = this.opts.systemInstruction;
    }
    if (tools.length > 0) {
      config["tools"] = tools;
    }

    const openPromise = new Promise<void>((resolve, reject) => {
      this.openResolver = resolve;
      this.openRejecter = reject;
    });

    const ai = new GoogleGenAI({ apiKey: this.opts.apiKey });

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
        onclose: () => this.stream.close(),
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

  cancelResponse(_audioEndMs: number): void {
    // Gemini handles interruption server-side via `interrupted`; no truncate API.
  }

  injectToolResult(toolId: string, text: string): void {
    const name = this.toolNames.get(toolId);
    if (!name) {
      this.stream.push({
        type: "error",
        cause: new Error(`unknown tool id "${toolId}" for Gemini tool response`),
        recoverable: false,
      });
      return;
    }
    this.requireSession().sendToolResponse({
      functionResponses: [{
        id: toolId,
        name,
        response: { result: text },
      }],
    });
  }

  async close(): Promise<void> {
    if (this.abortHandler) {
      // signal may already be gone; best-effort cleanup
    }
    this.session?.close();
    this.session = null;
    this.stream.close();
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
        this.toolNames.set(toolId, toolName);
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
