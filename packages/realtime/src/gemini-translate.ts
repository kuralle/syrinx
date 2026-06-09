// SPDX-License-Identifier: MIT

import type { Session, LiveServerMessage } from "@google/genai";

import { bytesToBase64, base64ToBytes } from "./base64.js";

const DEFAULT_MODEL = "gemini-3.5-live-translate-preview";
const OUTPUT_SAMPLE_RATE_HZ = 24_000;

export interface GeminiTranslateSession {
  sendAudio(pcm16: Uint8Array): void;
  signalAudioStreamEnd(): void;
  close(): Promise<void>;
}

export interface GeminiTranslateSessionOptions {
  readonly apiKey: string;
  readonly targetLanguageCode: string;
  readonly echoTargetLanguage?: boolean;
  readonly onAudio: (pcm16: Uint8Array, sampleRateHz: number) => void;
  readonly onText?: (text: string, role: "input" | "output", final: boolean) => void;
  readonly onError?: (cause: Error) => void;
}

export async function createGeminiTranslateSession(
  opts: GeminiTranslateSessionOptions,
): Promise<GeminiTranslateSession> {
  const { GoogleGenAI, Modality } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey: opts.apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });

  const session = await ai.live.connect({
    model: DEFAULT_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      translationConfig: {
        targetLanguageCode: opts.targetLanguageCode,
        echoTargetLanguage: opts.echoTargetLanguage ?? true,
      },
    },
    callbacks: {
      onmessage: (msg) => handleTranslateMessage(msg, opts),
      onerror: (ev) => {
        const cause = ev instanceof Error ? ev : new Error(String(ev));
        opts.onError?.(cause);
      },
    },
  });

  // Gemini Live Translate needs ~100ms input chunks. Feeding the engine's native 20ms frames
  // intermittently makes the model echo the SOURCE language instead of translating (~20-33%,
  // verified deterministically via Deepgram detect_language). Coalesce to 100ms here so callers
  // can keep sending 20ms frames. 100ms @ 16kHz PCM16 = 1600 samples = 3200 bytes (sample-aligned).
  const INPUT_CHUNK_BYTES = 3200;
  let buf = new Uint8Array(0);
  const flushChunk = (chunk: Uint8Array): void => {
    session.sendRealtimeInput({ audio: { data: bytesToBase64(chunk), mimeType: "audio/pcm;rate=16000" } });
  };
  const flushRemainder = (): void => {
    if (buf.length > 0) {
      flushChunk(buf);
      buf = new Uint8Array(0);
    }
  };

  return {
    sendAudio(pcm16: Uint8Array): void {
      const merged = new Uint8Array(buf.length + pcm16.length);
      merged.set(buf, 0);
      merged.set(pcm16, buf.length);
      buf = merged;
      while (buf.length >= INPUT_CHUNK_BYTES) {
        flushChunk(buf.subarray(0, INPUT_CHUNK_BYTES));
        buf = buf.slice(INPUT_CHUNK_BYTES);
      }
    },
    signalAudioStreamEnd(): void {
      flushRemainder();
      session.sendRealtimeInput({ audioStreamEnd: true });
    },
    async close(): Promise<void> {
      flushRemainder();
      session.close();
    },
  };
}

function handleTranslateMessage(
  msg: LiveServerMessage,
  opts: GeminiTranslateSessionOptions,
): void {
  const content = msg.serverContent;
  if (!content) return;

  if (content.inputTranscription?.text && opts.onText) {
    opts.onText(
      content.inputTranscription.text,
      "input",
      content.inputTranscription.finished ?? false,
    );
  }

  if (content.outputTranscription?.text && opts.onText) {
    opts.onText(
      content.outputTranscription.text,
      "output",
      content.outputTranscription.finished ?? false,
    );
  }

  const parts = content.modelTurn?.parts;
  if (!parts) return;

  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data && inline.mimeType?.startsWith("audio/")) {
      const rateMatch = /rate=(\d+)/.exec(inline.mimeType);
      const sampleRateHz = rateMatch ? Number(rateMatch[1]) : OUTPUT_SAMPLE_RATE_HZ;
      opts.onAudio(base64ToBytes(inline.data), sampleRateHz);
    }
  }
}

export { DEFAULT_MODEL as GEMINI_TRANSLATE_MODEL };
