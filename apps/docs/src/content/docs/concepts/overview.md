---
title: How Syrinx works
description: The packet bus, the session, plugins, and turn-taking — the mental model behind every Syrinx integration.
---

Every Syrinx conversation runs inside one `VoiceAgentSession`. Understanding four pieces gets you most of the way to reading (and writing) any pipeline: the **bus**, **plugins**, the **reasoner**, and the **interaction policy**.

## Everything is a packet on a bus

A `VoiceAgentSession` wires your plugins onto a `PipelineBus` — a typed publish/subscribe channel. Audio and text move through the session as packets, not function calls, so a plugin never has to know what produced the packet it's reacting to.

A cascade turn looks like this on the bus:

```
user.audio_received → stt.audio → [STT] → stt.result / eos.turn_complete
  → [reasoner] → llm.delta / llm.done
  → tts.text → [TTS] → tts.audio
```

Cross-cutting packets ride the same bus: `usage.recorded` (billing), `metric.conversation` (observability), `dtmf.received` / `call.transfer` (telephony), `stt.reconfigure` (mid-call biasing). See the full [packet reference](/reference/packets/).

:::tip
Because everything is a packet, you can observe a session (metrics, logging, a custom dashboard) by subscribing to the bus — you never need to fork or wrap a plugin to see what it's doing.
:::

## Plugins are the only thing that changes

An STT provider, a TTS provider, and a VAD are all a `VoicePlugin` — a small interface that subscribes to the packets it cares about and emits the packets downstream stages expect. Swapping Deepgram for ElevenLabs STT means registering a different plugin; nothing else in your session changes:

```ts
import { VoiceAgentSession } from '@kuralle-syrinx/core';
import { DeepgramSTTPlugin } from '@kuralle-syrinx/deepgram';
import { CartesiaTTSPlugin } from '@kuralle-syrinx/cartesia';

const session = new VoiceAgentSession({ plugins: { stt: {}, tts: {} } });
session.registerPlugin('stt', new DeepgramSTTPlugin(socketFactory));
session.registerPlugin('tts', new CartesiaTTSPlugin(socketFactory));
```

Underneath, every STT plugin is a thin wire protocol over the shared `stt-core` lifecycle (socket, reconnect, the interim/final funnel, usage billing); every TTS plugin is the same shape over `tts-core`. See [Providers](/providers/overview/) for the full list and their config.

## The reasoner drives the conversation

The reasoner is your LLM or agent — a `Reasoner` that takes a turn (the user's finalized text plus prior messages) and streams back `text-delta` / `tool-call` / `tool-result` / `finish` parts. Syrinx ships adapters for the Vercel AI SDK and Mastra, and a `ReasoningBridge` plugin that drives it on the cascade path. See [Build a voice agent](/guides/building-a-voice-agent/).

## The interaction policy owns turn-taking

Deciding *when* the user is done talking — and when a barge-in should interrupt the assistant — is centralized in an `InteractionPolicy`, not scattered across VAD and STT code. Syrinx ships a spectrum of policies so you can pick the right latency/accuracy tradeoff:

| Policy | How it decides | Runs on |
|---|---|---|
| Silence timer | A fixed silence window after the user stops speaking. | Anywhere, including the Workers edge. |
| Provider endpointing | The STT provider's own end-of-turn signal (Deepgram Flux's semantic EOT). | Anywhere, no local ONNX model required. |
| Smart Turn | Silero VAD + a semantic-completeness model fused together, so a pause mid-sentence doesn't cut the user off. | Node (local ONNX inference). |
| Voice Activity Projection | A full-duplex model that predicts turn-shift, hold, and backchannel continuously instead of only at silence. | Node and Workers. |

Whichever policy you choose, it feeds the same `eos.turn_complete` packet to your reasoner and the same barge-in signal to your TTS plugin — the rest of the pipeline doesn't know which one is active.

## Built for the voice-to-voice budget

Every layer exists to protect one number: the time between the user finishing a sentence and hearing the assistant's first word back. Two features exist purely to hide latency inside that budget:

- **Speculative generation** — the reasoner can start on a provider's *eager* end-of-turn signal, before the turn is confirmed, and discard the draft on a false start.
- **Per-turn latency decomposition** — every turn emits a `turn_latency` event breaking down time-to-first-audio into its STT, LLM, and TTS components, so a regression is diagnosable instead of just "it felt slow."

## Two runtimes, one engine

The kernel is socket-free: you inject a `SocketFactory` for your runtime — `createNodeWsSocket` for Node, `createWorkersSocket` for Cloudflare Workers — and the same session, plugins, and reasoner run unmodified on either. On Workers, each conversation lives in one hibernatable Durable Object. See [Deploy on Cloudflare](/guides/deploy-on-cloudflare/).

## Next

- [Build a voice agent](/guides/building-a-voice-agent/) — wire a pipeline end to end.
- [Providers](/providers/overview/) — STT, TTS, and realtime adapters.
- [Architecture reference](/reference/architecture/) — the package map, file by file.
