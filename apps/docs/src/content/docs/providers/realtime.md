---
title: Realtime providers
description: Config reference for the speech-to-speech (realtime) front models Syrinx ships.
---

A realtime provider is a single speech-to-speech model that takes audio in and streams audio out — no separate STT or TTS. In Syrinx you wrap one in a `RealtimeBridge`, which runs it as a plugin and gives you the same tools, resume, and observability surface as a cascade.

```ts
import { RealtimeBridge, fromOpenAIRealtime } from '@kuralle-syrinx/realtime';
import { createNodeWsSocket } from '@kuralle-syrinx/ws/node';

const adapter = fromOpenAIRealtime({ apiKey: process.env.OPENAI_API_KEY!, socketFactory: createNodeWsSocket });
session.registerPlugin('realtime', new RealtimeBridge(adapter));
```

Run the session with `endpointingOwner: "timer"` — a realtime model owns its own turn detection, so you don't register STT/VAD/TTS plugins.

:::note
`socketFactory` is the WebSocket dialer these adapters use — `createNodeWsSocket` on Node, `createWorkersSocket` on Cloudflare Workers. See [Socket factories](/providers/overview/#socket-factories).
:::

## OpenAI Realtime

```ts
import { fromOpenAIRealtime } from '@kuralle-syrinx/realtime';

const adapter = fromOpenAIRealtime({
  apiKey: process.env.OPENAI_API_KEY!,
  socketFactory: createNodeWsSocket,
  model: 'gpt-realtime',
});
```

| Option | Notes |
|---|---|
| `apiKey` | Required. |
| `model` | The OpenAI Realtime model id. |
| `socketFactory` | `createNodeWsSocket` on Node, `createWorkersSocket` on the edge. |
| `tools` | Function tools the model can call — see [delegating to a reasoner](/guides/building-a-voice-agent/#delegating-to-a-reasoner-from-a-realtime-front). |

On resume, OpenAI replays the transcript into the model (`conversation.item.create`) so a hibernated call picks back up with full context.

## Gemini Live

```ts
import { fromGeminiLive } from '@kuralle-syrinx/realtime';

const adapter = fromGeminiLive({
  apiKey: process.env.GEMINI_API_KEY!,
  socketFactory: createNodeWsSocket,
  systemInstruction: 'You are a helpful voice assistant.',
});
```

| Option | Notes |
|---|---|
| `apiKey` | Required. |
| `model` | The Gemini Live model id. |
| `systemInstruction` | System prompt. |
| `tools` | Function tools. |

Gemini Live resumes natively from its own session handle — Syrinx passes the handle through rather than replaying the transcript, so there's no double-applied history.

## Grok

Grok's realtime API is OpenAI-compatible, so it uses the same adapter shape:

```ts
import { fromGrokRealtime } from '@kuralle-syrinx/grok';

const adapter = fromGrokRealtime({ apiKey: process.env.XAI_API_KEY!, socketFactory: createNodeWsSocket });
```

## Half-cascade: realtime reasoning, your own TTS voice

If you want a realtime front's reasoning but a specific TTS voice or language, run the front **text-only** and let a Syrinx TTS plugin speak its transcript. Set the text-only modality on the adapter and register a TTS plugin instead of relying on the front's audio out. This pairs a strong reasoning front with the [TTS provider](/providers/tts/) of your choice.
