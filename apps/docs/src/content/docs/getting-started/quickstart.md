---
title: Quickstart
description: Install Syrinx from npm, set your provider keys, and build your first voice agent.
---

Syrinx is published on npm as `@kuralle-syrinx/*`. Install the packages you need, plug in your providers, and you have a voice agent — no repository to clone.

## Prerequisites

- Node 20+
- A [Deepgram](https://deepgram.com) API key (STT), an OpenAI (or other) LLM key, and a [Cartesia](https://cartesia.ai) API key (TTS) — or swap in any [supported provider](/providers/overview/)

## Install

```bash
npm install @kuralle-syrinx/core @kuralle-syrinx/deepgram @kuralle-syrinx/cartesia @kuralle-syrinx/aisdk ai @ai-sdk/openai
```

## Set your provider keys

```bash
DEEPGRAM_API_KEY=...
OPENAI_API_KEY=...
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...
```

## Build your first agent

Wire a cascade — Deepgram STT → an AI SDK reasoner → Cartesia TTS — with Deepgram owning turn detection:

```ts
import { VoiceAgentSession } from '@kuralle-syrinx/core';
import { DeepgramSTTPlugin } from '@kuralle-syrinx/deepgram';
import { CartesiaTTSPlugin } from '@kuralle-syrinx/cartesia';
import { ReasoningBridge, fromStreamText } from '@kuralle-syrinx/aisdk';
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const session = new VoiceAgentSession({
  plugins: {
    stt: { api_key: process.env.DEEPGRAM_API_KEY!, model: 'nova-3', sample_rate: 16000, emit_eos_on_final: true },
    bridge: {},
    tts: { api_key: process.env.CARTESIA_API_KEY!, voice_id: process.env.CARTESIA_VOICE_ID! },
  },
  endpointingOwner: 'provider_stt',
});

session.registerPlugin('stt', new DeepgramSTTPlugin());
session.registerPlugin('bridge', new ReasoningBridge(fromStreamText({
  model: openai('gpt-4.1-mini'),
  system: 'You are a helpful voice assistant. Keep your replies short.',
})));
session.registerPlugin('tts', new CartesiaTTSPlugin());
```

That's the whole agent: audio in becomes a transcript, the transcript becomes a reply, the reply becomes audio. Swap any provider — a different STT vendor, or a realtime speech-to-speech model instead of a cascade — and the session shape stays the same.

## Stream real audio into it

The session above is the conversation logic; to feed it live audio you attach a **transport**:

- **Browser** — Syrinx's resumable WebSocket audio protocol.
- **Telephony** — a [Twilio](/telephony/twilio/) or [Telnyx](/telephony/telnyx/) phone call.
- **Cloudflare Workers** — run the whole thing on the edge, one Durable Object per call. See [Deploy on Cloudflare](/guides/deploy-on-cloudflare/).

## See it run end to end

Want a complete, runnable headless demo — audio fixture in, transcript, reply, audio out, with per-stage latency timings — before wiring your own transport? Browse or run [`run-kuralle-cascade-clean.ts`](https://github.com/kuralle/syrinx/blob/main/examples/02-hello-voice-headless/scripts/run-kuralle-cascade-clean.ts) in [`examples/02-hello-voice-headless`](https://github.com/kuralle/syrinx/tree/main/examples/02-hello-voice-headless) on GitHub.

## Next

- [Build a voice agent](/guides/building-a-voice-agent/) — tools, realtime, and half-cascade.
- [Providers](/providers/overview/) — every STT, TTS, and realtime adapter, with config.
- [How Syrinx works](/concepts/overview/) — the mental model.
