---
title: Providers overview
description: How STT, TTS, and realtime providers plug in, and the shared lifecycle modules behind every adapter.
---

Every provider Syrinx ships is a **thin adapter** over one of three shared streaming-lifecycle modules. The module owns the socket, reconnect, the interim/final funnel, and usage billing; the provider implements only its wire protocol. That's what makes swapping a vendor a one-line change instead of a rewrite.

| Module | Owns | A provider implements |
|---|---|---|
| `@kuralle-syrinx/stt-core` | Socket, reconnect, the interim/final transcript funnel, `usage.recorded` audio-second billing, pre-handshake audio buffering, reconfigure/reset | An `SttWireProtocol`: `encodeFinalize`, `decode`, and optional `encodeAudio` / `onOpen` / `encodeReconfigure` |
| `@kuralle-syrinx/tts-core` | The multi-context streaming lifecycle, attribution, `usage.recorded` character billing | A `WireProtocol`: attribution plus encode text/finish/cancel and decode |
| `@kuralle-syrinx/realtime` | The `RealtimeBridge` plugin, capability negotiation, resume | A `RealtimeAdapter`: `sendAudio` / `sendText` / `requestResponse` / `cancelResponse`, tools, events |

## Pick a provider

- **[STT providers](/providers/stt/)** — Deepgram (Nova and Flux), ElevenLabs, Google, Grok.
- **[TTS providers](/providers/tts/)** — Cartesia, ElevenLabs, Deepgram Aura, Gemini, Grok, and any OpenAI-compatible endpoint.
- **[Realtime providers](/providers/realtime/)** — OpenAI Realtime, Gemini Live, and Grok's realtime API.

All of them run on Node and on the Cloudflare Workers edge — every socket connection is injectable, so you swap `createNodeWsSocket` for `createWorkersSocket` and nothing else changes.

## Mid-call reconfigure

Some STT providers let you bias recognition — keyterms, end-of-turn thresholds, language — without tearing down the session. See [STT reconfigure](/reference/stt-reconfigure/).

## Usage and pricing

Every STT, TTS, and LLM provider emits a `usage.recorded` packet (STT audio-seconds, TTS characters, LLM tokens). Turn that into a running dollar cost, or bound it with a spend cap — see [Usage & pricing](/reference/usage-and-pricing/).
