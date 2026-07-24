---
title: Quickstart
description: Install, set provider keys, and run a headless voice turn.
---

Syrinx is a pnpm monorepo. This quickstart runs a headless cascade voice turn against live providers.

## Prerequisites

- Node 20+, pnpm 11+
- Provider API keys (at minimum `DEEPGRAM_API_KEY` for STT, an LLM key, and a TTS key)

## Install

```bash
pnpm install
pnpm -r build
```

## Configure keys

Put provider keys in a repo-root `.env`:

```bash
DEEPGRAM_API_KEY=...
OPENAI_API_KEY=...
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...
```

## Run a headless voice turn

The `examples/02-hello-voice-headless` package hosts the live smokes:

```bash
pnpm -C examples/02-hello-voice-headless exec tsx scripts/run-kuralle-cascade-clean.ts
```

This streams a fixture through Deepgram STT → the reasoner → TTS and prints the per-stage cascade timings (STT finalize, LLM TTFT, TTS TTFB, end-to-end voice-to-voice).

## Next

- [Build a voice agent](/guides/building-a-voice-agent/) — wire your own pipeline and reasoner.
- [Deploy on Cloudflare](/guides/deploy-on-cloudflare/) — the Workers edge.
- [Providers](/providers/overview/) — the STT/TTS/realtime adapters.
