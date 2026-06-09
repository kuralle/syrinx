# G4 — syrinx VOICE on Cloudflare with kuralle brain

## Deployed URL

https://syrinx-voice-realtime-workers.mithushancj.workers.dev

- Health: `GET /health` → `ok`
- Voice edge: `wss://syrinx-voice-realtime-workers.mithushancj.workers.dev/ws?sessionId=<id>`

## Bundle

| Metric | Value |
|--------|-------|
| Total upload | 1986.25 KiB |
| Gzip | 342.20 KiB |
| Worker startup | 45 ms |
| nodejs_compat | enabled, no bundle errors |
| Bindings | `REALTIME_VOICE_CONVERSATIONS` (DO), `VECTORIZE` → `kuralle-university-kb` |

## What was driven (live)

`examples/02-hello-voice-headless/scripts/run-realtime-cf-bimodel-smoke.ts` against the **deployed** worker:

1. `GET /health` — 200 `ok`
2. WebSocket upgrade to `/ws` — 101, `ready` frame received
3. Streamed `university-cs-masters-deadline.wav` (OpenAI TTS fixture, no Cartesia) as JSON `audio` frames @ 16 kHz
4. Captured non-silent assistant audio (289,600 bytes PCM) + transcripts

**Result: PASS**

- User STT: *"What's the application deadline for the Computer Science Masters?"*
- Agent (voiced): *"…The application deadline for the Computer Science master's program is **March 31**."*
- Grounded March 31: **yes** (kuralle Vectorize RAG via `ask_university` delegate on CF)
- Turn duration: ~47 s (includes front lead-in + delegate + voiced answer)

## What was cited (not re-driven here)

- G1 local bi-model (`run-realtime-kuralle-bimodel-smoke.ts`) — same `fromKuralleRuntime` + `RealtimeBridge` pattern; used as architectural proof only. G4 re-proves the identical stack on the deployed DO.

## Close status

**CLOSED.** Voice-on-CF is live with kuralle as the realtime reasoner back-model. Deploy succeeds, endpoint reachable, live audio turn returns RAG-grounded March 31 from the populated `kuralle-university-kb` index.
