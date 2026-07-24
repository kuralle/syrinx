---
title: Deploy on Cloudflare
description: The Workers edge — one hibernatable Durable Object per conversation.
---

Syrinx runs first-party on Cloudflare Workers via `@kuralle-syrinx/cf-agents`' `withVoice(Agent)`. Each conversation is one hibernatable Durable Object; the engine dials provider sockets through the Workers fetch-upgrade path (`@kuralle-syrinx/ws/workers` `createWorkersSocket`).

## Deploy

```bash
pnpm --filter @kuralle-syrinx/server-workers exec wrangler deploy
# secrets
wrangler secret put DEEPGRAM_API_KEY
wrangler secret put OPENAI_API_KEY
```

## Durable Objects (one per transport)

`packages/server-workers/src/worker.ts` binds one `withVoice(Agent, {...})` DO per transport:

- `VoiceConversation` → `wss://<worker>/ws` (browser / edge, Syrinx JSON+envelope protocol)
- `TwilioVoiceConversation` → `/twilio` (Twilio Media Streams μ-law phone leg)
- `TelnyxVoiceConversation` → `/telnyx` (Telnyx Media Streaming — **unverified against a live carrier or a live Workers deploy**; unit-verified only)

The pipeline/brain is `liveCascadedPipeline` + `createLiveReasoner` (Deepgram STT + kuralle reasoner + Deepgram TTS). The realtime (bi-model) host is a separate `RealtimeVoiceConversation` DO (`worker-realtime.ts`).

## Webhooks

- Twilio: point the number's "A call comes in" webhook at `POST /incoming-call` → returns `<Connect><Stream>` TwiML to `/twilio`.
- Telnyx: point a Call Control app at `/telnyx-stream-start` → builds the TeXML `<Stream>` or `streaming_start` payload to `/telnyx`. (Live dispatch is carrier-gated.)

## Other endpoints

`GET /health`; `GET /recordings?sessionId=<id>` when an `RECORDINGS` R2 bucket is bound (per-call stereo `conversation.wav`).
