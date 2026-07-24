---
title: Building a voice agent
description: Wire a cascade or realtime pipeline and plug in your reasoner.
---

A Syrinx voice agent is a `VoiceAgentSession` (the runtime) fed by a transport, with a **pipeline** (STT/TTS or a realtime front) and a **reasoner** (your LLM/agent).

## Cascade

Compose an STT plugin, a reasoner, and a TTS plugin onto the bus:

```ts
import { VoiceAgentSession } from '@kuralle-syrinx/core';
import { DeepgramSTTPlugin, DeepgramTTSPlugin } from '@kuralle-syrinx/deepgram';

// STT plugin  -> stt.result -> your reasoner -> tts.text -> TTS plugin -> audio out
```

STT plugins consume `stt.audio` (the canonical ingress) and emit `stt.interim` / `stt.result`; the reasoner consumes `stt.result` / `eos.turn_complete` and emits `llm.delta` / `llm.done`; the TTS plugin consumes `tts.text` and emits `tts.audio`. Turn-taking (endpointing, barge-in) is owned by the interaction policy.

## Realtime (S2S)

Wrap a realtime adapter in a `RealtimeBridge`:

```ts
import { fromOpenAIRealtime, RealtimeBridge } from '@kuralle-syrinx/realtime';

const bridge = new RealtimeBridge({ adapter: fromOpenAIRealtime({ apiKey, model }) /* + tools, resume */ });
```

The bridge exposes the same tool, resume, and observability surface as the cascade, so a delegate/reasoner still applies.

## Reasoner

The reasoner is the `reasoner` param — any function producing a `Reasoner`. Syrinx ships a kuralle (RAG + flows) reasoner and AI-SDK / Mastra bridges; delegate runs emit `delegate.query` → `delegate.result` bus packets.

## On Cloudflare Workers

The same pipeline + reasoner run under `withVoice(Agent, { pipeline, reasoner })`. See [Deploy on Cloudflare](/guides/deploy-on-cloudflare/).
