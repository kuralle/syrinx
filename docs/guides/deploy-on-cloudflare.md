# Deploy Syrinx on Cloudflare

Goal: stand up a live Syrinx voice agent on Cloudflare Workers — browser **and** phone —
from the `@kuralle-syrinx/server-workers` template.

Cloudflare is a first-party Syrinx runtime: one hibernatable Durable Object per session,
built on `withVoice(Agent)` (the `@kuralle-syrinx/cf-agents` mixin over the Cloudflare
`agents` SDK). The Agent provides hibernation, the `keepAlive()` lease, and SQLite
natively — Syrinx is the voice engine on top.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan (Durable Objects require it).
- `wrangler` (bundled as a dev dependency of `server-workers`).
- Provider keys: `DEEPGRAM_API_KEY` + `OPENAI_API_KEY` for the cascaded host.

## 1. Pick a host

`server-workers` ships two deployable workers — same engine, different brain:

| Config | Worker | Pipeline |
|---|---|---|
| `wrangler.jsonc` (default) | `VoiceConversation` + `TwilioVoiceConversation` | cascaded — Deepgram STT → kuralle → Deepgram Aura TTS |
| `wrangler.realtime.jsonc` | `RealtimeVoiceConversation` | realtime — gpt-realtime / Gemini Live front + kuralle back |

The cascaded config also bundles the **telephony** host (`TwilioVoiceConversation`) and
the Twilio webhook, so one deploy serves browser and phone.

## 2. Bindings

`wrangler.jsonc` declares them (edit names/index to your account):

- **Durable Objects** — `VOICE_CONVERSATIONS` → `VoiceConversation`,
  `TWILIO_VOICE_CONVERSATIONS` → `TwilioVoiceConversation`, each a `new_sqlite_classes`
  migration (the agents SDK Agent is SQLite-backed).
- **R2** (optional) — `RECORDINGS` → your bucket, to capture per-call audio.
- **Vectorize** — `VECTORIZE` → your knowledge-base index (the kuralle reasoner's RAG).

## 3. Secrets

Copy `packages/server-workers/.dev.vars.example` → `.dev.vars` for local `wrangler dev`.
For production:

```
wrangler secret put DEEPGRAM_API_KEY
wrangler secret put OPENAI_API_KEY
```

## 4. Deploy

```
pnpm --filter @kuralle-syrinx/server-workers exec wrangler deploy --no-cache
```

> `--no-cache`: the build cache can ship stale source and give a false "fixed" signal.

## 5. Endpoints

| Path | Use |
|---|---|
| `wss://<worker>/ws?sessionId=<id>` | browser / edge voice |
| `wss://<worker>/twilio?sessionId=<callSid>` | Twilio Media Streams phone leg |
| `POST /incoming-call` | Twilio Voice webhook → `<Connect><Stream>` TwiML |
| `GET /health` | liveness |
| `GET /recordings?sessionId=<id>` | list R2 recordings (when `RECORDINGS` bound) |

## 6. Browser client

Use `@kuralle-syrinx/browser-client` — it auto-reconnects with backoff and resumes by
`sessionId`:

```ts
import { SyrinxBrowserClient } from "@kuralle-syrinx/browser-client";

const client = new SyrinxBrowserClient({ url: "wss://<worker>/ws" });
client.on((e) => { /* "ready" | "audio" | "reconnecting" | "reconnected" | … */ });
client.connect();
```

## 7. Phone (Twilio)

Point your Twilio number's **"A call comes in"** webhook at
`https://<worker>/incoming-call`. The handler returns TwiML that connects the PSTN leg
to `/twilio` over a bidirectional `<Stream>`; the Twilio `CallSid` becomes the session id.
(telnyx Media Streaming on the edge is not yet wired — see the #10 tracking issue.)

## 8. Verify locally first

No real account or phone needed — the runtime tests boot the worker in Miniflare/workerd:

```
# deterministic: boots in workerd, accepts /ws + /twilio upgrades, /incoming-call TwiML
pnpm --filter @kuralle-syrinx/server-workers test

# live turn in workerd (needs DEEPGRAM_API_KEY + OPENAI_API_KEY in repo .env):
#   cascaded /ws turn AND an emulated Twilio Media Streams call on /twilio
pnpm --filter @kuralle-syrinx/server-workers test:live
```

`test:live` emulates a phone call by speaking the Twilio Media Streams protocol at
`/twilio` — so you can prove the phone leg end-to-end without a carrier or a number.
