// SPDX-License-Identifier: MIT
//
// Versioned price catalog: usage.recorded quantities → USD.
// Unknown provider/model keys yield unpriced (never silent 0 for real providers).
// Declared local/self-hosted models are explicitly zero-cost.

import type { UsageRecordedPacket } from "./packets.js";

export interface SttPrice {
  readonly usdPerAudioSecond: number;
}

export interface LlmPrice {
  readonly usdPer1MInputTokens: number;
  readonly usdPer1MOutputTokens: number;
  readonly usdPer1MCachedInputTokens?: number;
}

export interface TtsPrice {
  readonly usdPer1MCharacters: number;
}

export interface PriceCatalog {
  readonly source: string;
  readonly version: string;
  /** Keys: `provider/model` (e.g. `deepgram/nova-3`). */
  readonly stt: Readonly<Record<string, SttPrice>>;
  readonly llm: Readonly<Record<string, LlmPrice>>;
  readonly tts: Readonly<Record<string, TtsPrice>>;
}

export type CostResult =
  | { readonly usd: number; readonly unpriced?: undefined }
  | { readonly usd: null; readonly unpriced: true };

function catalogKey(provider: string | undefined, model: string | undefined): string | null {
  if (!provider || !model) return null;
  return `${provider}/${model}`;
}

/**
 * Public list prices stamped into DEFAULT_PRICE_CATALOG.source.
 * STT $/audio-second from $/min ÷ 60. TTS is $/1M characters. LLM is $/1M tokens.
 */
export const DEFAULT_PRICE_CATALOG: PriceCatalog = {
  source:
    "voice-prices@2 | deepgram.com/pricing PAYG Nova-3 streaming monolingual $0.0077/min → $0.000128333/s; " +
    "deepgram.com/pricing Aura-2 TTS $0.030/1k chars → $30/1M; " +
    "cartesia.ai/pricing + docs.cartesia.ai/pricing ~1 credit/char, PAYG ~$50/1M chars (cloudtalk.io cartesia-pricing 2026); " +
    "openai tts-1 $15/1M chars (openai.com api pricing); gpt-4o-mini-tts text $0.60/1M (community/azure listed text input rate); " +
    "openai GPT-4.1-mini $0.40/$1.60 per 1M in/out (developers.openai.com/api/docs/pricing; Azure GPT-4.1-mini-2025-04-14 Global); " +
    "cloud.google.com/speech-to-text/pricing V2 standard recognition $0.016/min → $0.000266667/s (latest_long); " +
    "ai.google.dev/pricing Gemini 2.5 Flash TTS preview text $0.50/1M chars (Gemini API TTS text input rate, 2026); " +
    "grok/stt + grok/* TTS + epsilon/epsilon-tts intentionally ABSENT (no public list price → costOf unpriced, never silent $0)",
  version: "2",
  stt: {
    "deepgram/nova-3": { usdPerAudioSecond: 0.0077 / 60 },
    "deepgram/nova-2": { usdPerAudioSecond: 0.0077 / 60 },
    "deepgram/flux-general-en": { usdPerAudioSecond: 0.0077 / 60 },
    // Google Cloud Speech-to-Text V2 standard streaming recognition list rate.
    "google/latest_long": { usdPerAudioSecond: 0.016 / 60 },
    "google/latest_short": { usdPerAudioSecond: 0.016 / 60 },
    "google/chirp_2": { usdPerAudioSecond: 0.016 / 60 },
    "local/whisper": { usdPerAudioSecond: 0 },
    // grok/stt: no public list price — omit so costOf → unpriced
  },
  llm: {
    "openai/gpt-4.1-mini": {
      usdPer1MInputTokens: 0.4,
      usdPer1MOutputTokens: 1.6,
      usdPer1MCachedInputTokens: 0.1,
    },
    "local/llm": {
      usdPer1MInputTokens: 0,
      usdPer1MOutputTokens: 0,
    },
  },
  tts: {
    "cartesia/sonic-3": { usdPer1MCharacters: 50 },
    "openai/gpt-4o-mini-tts": { usdPer1MCharacters: 0.6 },
    "openai/tts-1": { usdPer1MCharacters: 15 },
    "deepgram/aura-2-thalia-en": { usdPer1MCharacters: 30 },
    // Gemini TTS preview models — Gemini API TTS text input list rate.
    "gemini/gemini-3.1-flash-tts-preview": { usdPer1MCharacters: 0.5 },
    "gemini/gemini-2.5-flash-preview-tts": { usdPer1MCharacters: 0.5 },
    "gemini/gemini-2.5-pro-preview-tts": { usdPer1MCharacters: 0.5 },
    "local/tts": { usdPer1MCharacters: 0 },
    // grok/* voice keys + epsilon/epsilon-tts: no public list — omit → unpriced
  },
};

export function costOf(usage: UsageRecordedPacket, catalog: PriceCatalog): CostResult {
  const key = catalogKey(usage.provider, usage.model);
  if (!key) return { usd: null, unpriced: true };

  switch (usage.stage) {
    case "stt": {
      const price = catalog.stt[key];
      if (!price) return { usd: null, unpriced: true };
      const seconds = usage.audioSeconds ?? 0;
      return { usd: seconds * price.usdPerAudioSecond };
    }
    case "tts": {
      const price = catalog.tts[key];
      if (!price) return { usd: null, unpriced: true };
      const characters = usage.characters ?? 0;
      return { usd: (characters / 1_000_000) * price.usdPer1MCharacters };
    }
    case "llm": {
      const price = catalog.llm[key];
      if (!price) return { usd: null, unpriced: true };
      const input = usage.inputTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      const cached = usage.cachedInputTokens ?? 0;
      const cachedRate = price.usdPer1MCachedInputTokens ?? price.usdPer1MInputTokens;
      // Prefer charging cached tokens at the cached rate when present; non-cached input is the remainder.
      const nonCachedInput = Math.max(0, input - cached);
      const usd =
        (nonCachedInput / 1_000_000) * price.usdPer1MInputTokens +
        (cached / 1_000_000) * cachedRate +
        (output / 1_000_000) * price.usdPer1MOutputTokens;
      return { usd };
    }
    default:
      return { usd: null, unpriced: true };
  }
}
