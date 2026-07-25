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

// Nothing happens until you start it: `start()` runs each plugin's init chain
// and begins draining the packet bus. Register every plugin before calling it.
await session.start();
```

That's the whole agent: audio in becomes a transcript, the transcript becomes a reply, the reply becomes audio. Swap any provider — a different STT vendor, or a realtime speech-to-speech model instead of a cascade — and the session shape stays the same.

## Feed it audio

A started session is idle until something pushes audio frames at it. That something is a **transport**, and which one you pick is the difference between trying this locally and shipping it:

- **A WAV file** — the fastest way to see a full turn on your own machine, no server and no microphone. See [Run it locally](/getting-started/run-it-locally/).
- **Browser** — Syrinx's resumable WebSocket audio protocol, for real microphone input.
- **Telephony** — a [Twilio](/telephony/twilio/) or [Telnyx](/telephony/telnyx/) phone call.
- **Cloudflare Workers** — run the whole thing on the edge, one Durable Object per call. See [Deploy on Cloudflare](/guides/deploy-on-cloudflare/).

## See it run end to end

**[Run it locally](/getting-started/run-it-locally/)** walks the shortest path from the code above to a turn you can watch happen: a fixture WAV in, a transcript, a reply, and spoken audio out — then the same agent driven from a browser with your microphone.

## Next

- [Build a voice agent](/guides/building-a-voice-agent/) — tools, realtime, and half-cascade.
- [Providers](/providers/overview/) — every STT, TTS, and realtime adapter, with config.
- [How Syrinx works](/concepts/overview/) — the mental model.
