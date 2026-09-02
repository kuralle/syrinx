---
title: Building a voice agent
description: Wire a cascade or realtime pipeline, plug in your reasoner, and add tools.
---

A Syrinx voice agent is a `VoiceAgentSession` — the runtime — fed by a transport, with a **pipeline** (STT + TTS, or a realtime front) and a **reasoner** (your LLM or agent). This guide wires each piece.

## Cascade: STT → reasoner → TTS

Per-slot config (API keys, model, voice) goes in the `VoiceAgentSession` constructor; the plugin instances are registered by slot — `stt`, the reasoner `bridge`, and `tts`:

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

// Register every plugin first, then start: `start()` runs the init chain and
// starts draining the bus. Until it resolves, the session does nothing.
await session.start();
```

:::tip
This is a runnable example, not a sketch — [`hello-voice-agent.ts`](https://github.com/kuralle/syrinx/blob/main/examples/02-hello-voice-headless/src/hello-voice-agent.ts) is this exact agent with a `main()` that feeds it a WAV fixture and prints the turn. Run it in one command: see [Run it locally](/getting-started/run-it-locally/).
:::

Each plugin only cares about the packets it consumes and produces:

- The **STT plugin** consumes `stt.audio` (the canonical audio ingress) and emits `stt.interim` / `stt.result`.
- The **reasoner bridge** consumes `stt.result` and `eos.turn_complete`, and emits `llm.delta` / `llm.done` (or a recoverable `llm.error`).
- The **TTS plugin** consumes `tts.text` and emits `tts.audio`.

Turn-taking — deciding when the user is done talking, and handling barge-in — is owned by the session's [interaction policy](/concepts/overview/#the-interaction-policy-owns-turn-taking), not by the STT or TTS plugin.

## Realtime: speech-to-speech

For the lowest-latency path, wrap a realtime adapter in a `RealtimeBridge` instead of a cascade:

```ts
import { RealtimeBridge, fromOpenAIRealtime } from '@kuralle-syrinx/realtime';
import { createNodeWsSocket } from '@kuralle-syrinx/ws/node';

const adapter = fromOpenAIRealtime({
  apiKey: process.env.OPENAI_API_KEY!,
  socketFactory: createNodeWsSocket,
});

session.registerPlugin('realtime', new RealtimeBridge(adapter));
```

Run the session with `endpointingOwner: "timer"` — the realtime model owns its own turn detection, so no STT/VAD/TTS plugins are registered. See [Realtime providers](/providers/realtime/) for OpenAI, Gemini, and Grok.

### Delegating to a reasoner from a realtime front

A realtime model is a great conversational surface but a shallow reasoner — it doesn't run your tools or RAG well on its own. Pass a `Reasoner` as the bridge's second argument and a tool name as its third, and the realtime front delegates to it as a tool call while staying the voice the user hears:

```ts
import { fromStreamText } from '@kuralle-syrinx/aisdk';

const reasoner = fromStreamText({ model, system, tools: { lookupOrder } });
const adapterWithTool = fromOpenAIRealtime({
  ...opts,
  tools: [{ name: 'ask_backend', description: '...', parameters: { /* JSON Schema */ } }],
});

session.registerPlugin('realtime', new RealtimeBridge(adapterWithTool, reasoner, 'ask_backend'));
```

The bridge feeds the reasoner's answer back to the front model as a structured result so it repeats facts faithfully instead of paraphrasing, and the session emits `tool_call_cue` events (`started` / `delayed` / `complete` / `failed`) your client can use to show a "thinking" indicator while the reasoner runs.

## Half-cascade: a realtime front with Syrinx TTS

If you want a realtime front's reasoning but a specific TTS voice or language, run the front text-only and let a Syrinx TTS plugin speak the transcript — see the `modalities: ["text"]` option on realtime adapters in [Realtime providers](/providers/realtime/).

## Adding tools to a cascade reasoner

Tools are just part of your reasoner backend's config — the AI SDK and Mastra adapters pass them straight through:

```ts
import { tool } from 'ai';
import { z } from 'zod';

const lookupOrder = tool({
  description: 'Look up an order by id',
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ status: 'shipped' }),
});

const reasoner = fromStreamText({ model, system, tools: { lookupOrder } });
```

The bridge emits `llm.tool_call` / `llm.tool_result` on the bus as the reasoner invokes tools, so you can observe or log tool use without touching the reasoner itself.

## On Cloudflare Workers

The same pipeline and reasoner run under `withVoice(Agent, { stt, tts, reasoner })` on the Workers edge — see [Deploy on Cloudflare](/guides/deploy-on-cloudflare/).
