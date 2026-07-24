---
title: Introduction
description: What Syrinx is, the three architectures, and how the pieces fit.
---

**Syrinx** is a TypeScript-native voice engine and SDK. It owns the **transport edge** — a resumable WebSocket audio protocol plus telephony carriers (Twilio, Telnyx, SmartPBX) — and hands the agent runtime a clean stream of mono PCM16 audio. On top of that it wires a **swappable voice pipeline**.

Packages are published under `@kuralle-syrinx/*`.

## Three architectures

- **Cascade** — STT → LLM → TTS. The classic pipeline: a streaming STT provider transcribes, a reasoner (LLM/agent) responds, a streaming TTS provider speaks. Turn-taking is owned by an endpointer (smart-turn ONNX, or provider endpointing).
- **Native realtime (S2S)** — a speech-to-speech front model (OpenAI Realtime, Gemini Live) handles audio in and out directly, wrapped by a `RealtimeBridge` so the rest of the engine (tools, resume, observability) still applies.
- **Half-cascade** — a realtime front runs text-only (`modalities:["text"]`) and Syrinx TTS drives speech from the assistant transcript.

One `VoiceAgentSession` shell and one interaction policy sit above all three.

## The layers

| Layer | What it is |
|---|---|
| **Transport** | `@kuralle-syrinx/ws` (resumable WebSocket), `server-websocket` (Node host + Twilio/Telnyx/SmartPBX), `server-workers` (Cloudflare Workers edge) |
| **Streaming lifecycle** | `stt-core`, `tts-core`, `realtime` — a provider is just a wire protocol over a shared socket/reconnect/funnel/billing engine |
| **Providers** | Deepgram (incl. Flux + nova), Cartesia, ElevenLabs, Google, Grok, Gemini, OpenAI-compatible TTS |
| **Runtime** | `@kuralle-syrinx/core` (`VoiceAgentSession`, packets, pricing, usage), `cf-agents` (`withVoice(Agent)`) |

## Runs on Node and Cloudflare Workers

The engine is socket-free at its core: inject a Node `ws` socket factory or the Workers fetch-upgrade factory. On the edge, each conversation is one hibernatable Durable Object (browser `/ws`, Twilio `/twilio`, Telnyx `/telnyx`).

Continue to the [Quickstart](/getting-started/quickstart/).
