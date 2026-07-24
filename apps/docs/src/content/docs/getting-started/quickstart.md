---
title: Quickstart
description: Install Syrinx, set your provider keys, and run a live voice turn in a few minutes.
---

This quickstart runs a headless voice turn end to end — audio in, transcript, LLM reply, audio out — against live providers, so you can hear the engine work before you write any application code.

## Prerequisites

- Node 20+ and pnpm 11+
- A [Deepgram](https://deepgram.com) API key (STT), an OpenAI (or other) LLM key, and a [Cartesia](https://cartesia.ai) API key (TTS) — or swap in any [supported provider](/providers/overview/)

## Clone and install

```bash
git clone https://github.com/kuralle/syrinx.git
cd syrinx
pnpm install
pnpm -r build
```

## Set your provider keys

Create a `.env` file at the repo root:

```bash
DEEPGRAM_API_KEY=...
OPENAI_API_KEY=...
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...
```

:::note
Only the STT/LLM/TTS keys for the providers you're using are required. See [Providers](/providers/overview/) for every supported vendor and its config keys.
:::

## Run a live voice turn

```bash
pnpm -C examples/02-hello-voice-headless exec tsx scripts/run-kuralle-cascade-clean.ts
```

This streams a fixture recording through Deepgram STT → your reasoner → Cartesia TTS, and prints the per-stage timings: STT finalize, LLM time-to-first-token, TTS time-to-first-byte, and total voice-to-voice latency.

```
stt.finalize     124ms
llm.ttft         412ms
tts.ttfb          88ms
voice_to_voice   734ms
```

## What just happened

`VoiceAgentSession` wired three plugins onto one packet bus: an STT plugin turned audio into text, a reasoner turned text into a reply, and a TTS plugin turned the reply into audio. Every provider you swap in later — a different STT vendor, a realtime speech-to-speech model instead of a cascade — plugs into the same session shape. Read [How Syrinx works](/concepts/overview/) for the mental model.

## Next

- [Build a voice agent](/guides/building-a-voice-agent/) — wire your own pipeline and reasoner.
- [Deploy on Cloudflare](/guides/deploy-on-cloudflare/) — run the same engine on the Workers edge.
- [Providers](/providers/overview/) — every STT, TTS, and realtime adapter Syrinx ships.
