---
title: Deploy on Cloudflare Workers
description: Run Syrinx as a hibernatable Durable Object per conversation, with browser and telephony transports.
---

Cloudflare Workers is a first-party runtime for Syrinx, not an afterthought — the same engine that runs on Node runs on the edge via `@kuralle-syrinx/cf-agents`' `withVoice(Agent)`. Each conversation is one hibernatable Durable Object; provider sockets dial out through the Workers fetch-upgrade path.

## Add `withVoice` to an Agent

```ts
import { Agent, routeAgentRequest } from 'agents';
import { withVoice } from '@kuralle-syrinx/cf-agents';
import { DeepgramSTTPlugin } from '@kuralle-syrinx/deepgram';
import { CartesiaTTSPlugin } from '@kuralle-syrinx/cartesia';
import { createWorkersSocket } from '@kuralle-syrinx/ws/workers';

export class VoiceConversation extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: {
    kind: 'cascaded',
    stt: (env) => ({
      plugin: new DeepgramSTTPlugin(createWorkersSocket),
      config: { api_key: env.DEEPGRAM_API_KEY, model: 'nova-3', sample_rate: 16000 },
    }),
    tts: (env) => ({
      plugin: new CartesiaTTSPlugin(createWorkersSocket),
      config: { api_key: env.CARTESIA_API_KEY, voice_id: env.CARTESIA_VOICE_ID },
    }),
  },
  reasoner: (env) => yourReasoner(env),
}) {}

export default {
  fetch: (request: Request, env: Env) =>
    routeAgentRequest(request, env).then((r) => r ?? new Response('Not found', { status: 404 })),
};
```

`agents` is a peer dependency — install it alongside `@kuralle-syrinx/cf-agents`. `withVoice` also accepts a realtime pipeline (`kind: "realtime"`); see [Realtime providers](/providers/realtime/).

:::tip
A complete, deployable Worker — one cascaded agent and one realtime agent, with `wrangler.jsonc` and bindings — is in [`examples/03-cf-agent-voice`](https://github.com/kuralle/syrinx/tree/main/examples/03-cf-agent-voice) on GitHub.
:::

## Deploy

```bash
npx wrangler deploy

npx wrangler secret put DEEPGRAM_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CARTESIA_API_KEY
```

## One Durable Object per transport

The reference Worker (`packages/server-workers/src/worker.ts`) binds one `withVoice(Agent, {...})` Durable Object per transport:

| Route | Durable Object | Transport |
|---|---|---|
| `wss://<worker>/ws` | `VoiceConversation` | Browser / edge client, Syrinx's JSON+envelope protocol |
| `/twilio` | `TwilioVoiceConversation` | Twilio Media Streams, μ-law 8 kHz |
| `/telnyx` | `TelnyxVoiceConversation` | Telnyx Media Streaming — see the [Preview] callout below |

:::caution[Preview]
The Telnyx-on-Workers route is built and unit-tested, but not yet certified against a live carrier or a live Workers deployment. See [Telephony](/telephony/overview/) before routing production call traffic through it.
:::

## Wire up telephony webhooks

- **Twilio** — point the phone number's "A call comes in" webhook at `POST /incoming-call`. It returns `<Connect><Stream>` TwiML pointed at `/twilio`.
- **Telnyx** — point a Call Control application at `/telnyx-stream-start`. It builds the TeXML `<Stream>` (or Call Control `streaming_start`) payload for `/telnyx`.

See [Twilio](/telephony/twilio/) and [Telnyx](/telephony/telnyx/) for the full setup.

## Other endpoints

- `GET /health` — liveness check.
- `GET /recordings?sessionId=<id>` — fetch a per-call stereo `conversation.wav` when a `RECORDINGS` R2 bucket is bound.

## Durable conversation history

By default, conversation history (and a realtime provider's resume handle) persists in the Agent's own SQLite storage and survives Durable Object eviction — a call that gets hibernated mid-conversation picks back up with full context. Set `durableHistory: false` on `withVoice` to opt out.

## Next

- [Telephony](/telephony/overview/) — carriers, codecs, DTMF, and call transfer.
- [Providers](/providers/overview/) — every provider works unmodified on Workers; each is socket-injectable.
