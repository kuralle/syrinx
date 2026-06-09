# G4b — CASCADE voice on Cloudflare with kuralle + Deepgram TTS

## Deployed URL

https://syrinx-voice-server-workers.mithushancj.workers.dev

- Health: `GET /health` → `ok`
- Voice edge: `wss://syrinx-voice-server-workers.mithushancj.workers.dev/ws?sessionId=<id>`

## Bundle

| Metric | Value |
|--------|-------|
| Total upload | 2023.23 KiB |
| Gzip | 350.17 KiB |
| Worker startup | 65 ms |
| nodejs_compat | enabled |
| Bindings | `VOICE_CONVERSATIONS` (DO), `VECTORIZE` → `kuralle-university-kb`, `RECORDINGS` (R2) |

## What was driven (live)

`examples/02-hello-voice-headless/scripts/run-cascade-cf-smoke.ts` against the **deployed** cascade worker:

1. `GET /health` — 200 `ok`
2. WebSocket upgrade to `/ws` — 101, `ready` frame received
3. Streamed `university-cs-masters-deadline.wav` as JSON `audio` frames @ 16 kHz
4. Captured non-silent Deepgram Aura TTS audio (124,160 bytes PCM) + transcripts

**Result: PASS**

- User STT: *"What's the application deadline for the computer science masters?"*
- Agent (kuralle + Deepgram TTS): *"The application deadline for the computer science master's program is **March 31**."*
- Grounded March 31: **yes** (kuralle Vectorize RAG on CF)
- First-audio latency (after last uplink frame): **1542 ms**
- Turn wall time: ~49 s

## What was cited (not re-driven here)

- G2 local cascade (`run-kuralle-cascade-clean.ts`) — architectural baseline for STT ~0.4s + V2V ~1.5–2.0s with Deepgram TTS locally. G4b re-proves the same kuralle brain + Deepgram TTS stack on the deployed CF DO.

## Realtime worker unaffected

`wrangler deploy --dry-run -c wrangler.realtime.jsonc` still succeeds (1986 KiB). Realtime bi-model worker unchanged.

## Close status

**CLOSED.** Cascade voice-on-CF is live with kuralle as the reasoner (Vectorize RAG) and Deepgram STT + Deepgram Aura TTS. Deploy succeeds, endpoint reachable, live audio turn returns RAG-grounded March 31.
