---
title: Providers overview
description: How STT, TTS, and realtime providers plug in — and the shared lifecycle modules behind them.
---

A provider in Syrinx is a **thin adapter** over a shared streaming lifecycle module. The module owns the socket, reconnect/replay, the interim/final funnel, usage billing, and buffering; the provider implements only its wire protocol.

## Shared lifecycle modules

- **`@kuralle-syrinx/stt-core`** — streaming STT. A provider implements `SttWireProtocol` (`encodeFinalize`, `decode`, optional `encodeAudio` / `onOpen` / `encodeReconfigure` / `attach` / `onFinalizeSent`). The engine owns context tracking, the smart-turn-safe transcript funnel, `usage.recorded{stage:"stt"}` delta-billing, pre-handshake audio buffering, and `reconfigure`/`reset`.
- **`@kuralle-syrinx/tts-core`** — streaming TTS. A provider implements a `WireProtocol` (attribution + encode text/finish/cancel + decode); the engine owns the multi-context streaming lifecycle and sideband usage.
- **`@kuralle-syrinx/realtime`** — native S2S. A provider implements a `RealtimeAdapter` (capability-negotiated: `sendAudio`/`sendText`/`requestResponse`/`cancelResponse`/tools/events); the `RealtimeBridge` runs it as a `VoicePlugin`.

## STT providers

| Provider | Package | Notes |
|---|---|---|
| Deepgram nova | `@kuralle-syrinx/deepgram` | Flagship cascade STT; Finalize timeout/fallback state machine on the `stt-core` async-emit seam |
| Deepgram Flux | `@kuralle-syrinx/deepgram` | Semantic end-of-turn (eager EOT / retract) for speculative generation; edge cascade |
| ElevenLabs | `@kuralle-syrinx/elevenlabs` | Scribe v2 Realtime |
| Google | `@kuralle-syrinx/google` | GCP Speech-to-Text v2 |
| Grok | `@kuralle-syrinx/grok` | xAI STT |

All five run on `stt-core`. See [STT reconfigure](/reference/stt-reconfigure/) for mid-call keyterm/endpointing/language biasing.

## TTS providers

Cartesia (`@kuralle-syrinx/cartesia`), ElevenLabs (multi-context WS), Grok, Gemini, and an OpenAI-compatible TTS (`@kuralle-syrinx/openai-tts`) — all on `tts-core`.

## Realtime (S2S) providers

OpenAI Realtime (`fromOpenAIRealtime`) and Gemini Live (`fromGeminiLive`), both in `@kuralle-syrinx/realtime`; Grok realtime via the OpenAI-compatible adapter.

## Usage & pricing

Every STT/TTS/LLM provider emits `usage.recorded` (STT `audioSeconds`, TTS `characters`, LLM tokens). `@kuralle-syrinx/core`'s `DEFAULT_PRICE_CATALOG` turns those into dollars, and a `SpendCapGuard` bounds them.
