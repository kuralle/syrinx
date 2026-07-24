---
title: Introduction
description: What Syrinx is, the three architectures it ships, and where to go next.
---

Syrinx is a TypeScript-native voice engine for building real-time voice agents. It owns the hard infrastructure — a resumable audio transport, telephony carriers, streaming provider lifecycles, turn-taking — so you can focus on the conversation, not the plumbing.

Point it at your STT, LLM, and TTS providers (or a single speech-to-speech model), plug in your reasoner, and you have a phone- or browser-facing voice agent with barge-in, reconnect, and usage metering built in.

```bash
npm install @kuralle-syrinx/core @kuralle-syrinx/deepgram @kuralle-syrinx/cartesia
```

:::tip
New to Syrinx? Start with the [Quickstart](/getting-started/quickstart/) — it runs a live voice turn in a few minutes.
:::

## What you get

- **A transport layer that's already solved.** A resumable WebSocket protocol for browsers, plus PSTN termination for Twilio, Telnyx, and SmartPBX. Reconnect, mid-call resume, and jitter buffering are handled for you.
- **A vendor-agnostic pipeline.** Swap STT, LLM, and TTS providers without touching your application code — every provider is a thin adapter over the same streaming lifecycle.
- **Turn-taking that isn't a stopwatch.** An interaction policy owns endpointing and barge-in, from a simple silence timer up to semantic end-of-turn and full-duplex voice-activity projection.
- **One engine, two runtimes.** The same session runs on a Node server or as a hibernatable Cloudflare Durable Object — no rewrite to go to the edge.

## Pick your architecture

Syrinx supports three ways to wire the conversation loop. All three run inside the same `VoiceAgentSession` and share the same tool, resume, and observability surface.

| Architecture | How it works | Reach for it when |
|---|---|---|
| **Cascade** | STT → your reasoner → TTS. A streaming STT provider transcribes, your LLM/agent responds, a streaming TTS provider speaks. | You want full control over each stage and best-in-class provider choice per stage. |
| **Native realtime (S2S)** | A speech-to-speech model (OpenAI Realtime, Gemini Live) handles audio in and audio out directly. | You want the lowest-latency, most natural-sounding voice with minimal wiring. |
| **Half-cascade** | A realtime front runs text-only and a Syrinx TTS provider speaks the transcript. | You want a realtime front's reasoning with a specific TTS voice or language it doesn't natively support well. |

Read more in [How Syrinx works](/concepts/overview/).

## The building blocks

| Layer | Packages | What it does |
|---|---|---|
| **Transport** | `@kuralle-syrinx/ws`, `server-websocket`, `server-workers` | Resumable WebSocket audio; Twilio/Telnyx/SmartPBX carriers; the Cloudflare Workers edge. |
| **Streaming lifecycle** | `stt-core`, `tts-core`, `realtime` | The socket, reconnect, funnel, and billing logic shared by every provider — a provider only implements its wire protocol. |
| **Providers** | `deepgram`, `cartesia`, `elevenlabs`, `google`, `grok`, `gemini`, `openai-tts` | STT, TTS, and realtime adapters. See [Providers](/providers/overview/). |
| **Runtime** | `core`, `cf-agents` | `VoiceAgentSession`, the packet bus, pricing/usage, and `withVoice(Agent)` for Cloudflare. |

Packages are published under `@kuralle-syrinx/*` on npm.

## Next steps

- [Quickstart](/getting-started/quickstart/) — install and run a live voice turn.
- [Build a voice agent](/guides/building-a-voice-agent/) — wire your own pipeline and reasoner.
- [Deploy on Cloudflare](/guides/deploy-on-cloudflare/) — ship on the Workers edge.
