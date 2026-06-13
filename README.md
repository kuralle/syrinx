# Syrinx

> Open voice orchestration and media-transport layer for [Kuralle](https://github.com/kuralle).

Syrinx is the self-hostable voice engine behind Kuralle, the open alternative to
closed "voice agent API" platforms. It keeps provider and client quirks at the
transport edge and hands the agent runtime a clean stream of mono PCM16 audio.

## What it provides

- Resumable WebSocket audio protocol (mono PCM16, turn and session management,
  sequence and sample-rate locks, reconnect within a retention window).
- Telephony adapters: SIP, Twilio, LiveKit.
- A provider-testing suite for realtime audio backends.
- Runs on Node **and** Cloudflare Workers — one hibernatable Durable Object per
  conversation (`WebSocketPair` inbound, timers→DO alarms, SQLite session store,
  optional R2 call recording). See `docs/serverless-edge-port-implementation-notes.md`.

## Edge deployment (Cloudflare Workers)

The `@kuralle-syrinx/server-workers` package is the deployable template: it runs the
full engine — live Deepgram STT + OpenAI + Deepgram Aura TTS — on
`withVoice(Agent)` (the `@kuralle-syrinx/cf-agents` mixin over the Cloudflare `agents`
SDK), one hibernatable Durable Object per session. The Agent provides hibernation, the
`keepAlive()` lease, and SQLite natively — no hand-rolled schedulers or session stores.

```
pnpm --filter @kuralle-syrinx/server-workers exec wrangler deploy
# set DEEPGRAM_API_KEY / OPENAI_API_KEY via `wrangler secret put` (see .dev.vars.example)
```

Endpoints: `wss://<worker>/ws?sessionId=<id>` (browser/edge voice),
`wss://<worker>/twilio?sessionId=<callSid>` (Twilio Media Streams phone leg),
`POST /incoming-call` (Twilio Voice webhook → `<Connect><Stream>` TwiML),
`GET /health`, `GET /recordings?sessionId=<id>` (lists R2 recordings). Bind an R2
bucket as `RECORDINGS` to capture, per call, a stereo `conversation.wav` (user left /
assistant right, time-aligned) plus `user.wav` / `assistant.wav` stems and a
`manifest.json`.

Full walkthrough — bindings, secrets, browser + phone, local verify:
**[Deploy Syrinx on Cloudflare](docs/guides/deploy-on-cloudflare.md)**.

## Guides

**[Building a voice agent](docs/guides/building-a-voice-agent.md)** — end-to-end guide: kuralle-agents (brain) + Syrinx (voice), all bridges, Node and Cloudflare deploy.

## Playground

Live browser demo — **[Syrinx Studio](https://syrinx-studio.mithushancj.workers.dev)**
(`apps/studio`, a Cloudflare static-assets Worker): mic capture (server owns turns — no
client VAD), a Web-Audio visualizer, and a live transcript over the WebSocket audio
protocol. Use the `?ws=` switcher to point it at **your own** hosted voice worker
(`wss://<your-worker>/ws?sessionId=<id>`) — two reference shapes ship in
`@kuralle-syrinx/server-workers`: a **cascade** path (Deepgram STT → reasoner → TTS) and a
**realtime bi-model** path (gpt-realtime front → reasoner back). A bundled "Play sample" /
`sample.wav` no-mic path gives a deterministic demo turn.

> Deploy your own voice worker (`wrangler deploy`) and **add auth** before exposing its `/ws`
> — voice endpoints are unauthenticated by default and incur provider cost per connection.

## Configuration

Syrinx reads provider credentials from the environment. Copy your keys into a
local `.env` (which is gitignored and never committed):

```
OPENAI_API_KEY=
GEMINI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
DEEPGRAM_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
CARTESIA_API_KEY=
CARTESIA_VOICE_ID=
```

See `docs/websocket-audio-protocol.md` for the wire protocol and
`PROVIDER-TESTING.md` for the provider test matrix.

## Contributing

New here? Start with **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** — it's the
orientation guide: what to read in what order, the package map, how to run the
engine locally, and the bar a change clears before it ships.

## License

MIT
