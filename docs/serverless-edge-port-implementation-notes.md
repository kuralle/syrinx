# Serverless edge-port implementation notes

> **Status (2026-06-05): shipped and deployed.** The Cloudflare Workers verdict in
> `serverless-portability-review.md` (§1: "NO — cannot run today") is resolved. The
> worker is **live** at `https://syrinx-voice-server-workers.mithushancj.workers.dev`
> driving real Deepgram + OpenAI + Cartesia turns inside a Durable Object, with R2
> call recording. The initial stub session was replaced by a live `VoiceAgentSession`.
> See "Live wiring, keep-alive, recording & deployment" below.

Assumptions
- The Workers app must prove that the Syrinx browser transport pipeline boots and drives a turn inside a Durable Object without statically loading Node-only websocket/server/native modules.
- Provider credentials are supplied as Workers secrets. The worker package originally shipped a deterministic stub session for the runtime proof; it has since been replaced by a live `VoiceAgentSession` injected through the same DO/transport seams (the stub is gone).

Decisions
- Keep the existing Node websocket server untouched for Node callers and add edge-only subpaths instead of in-body runtime guards.
- Make provider socket defaults lazy in `initialize()` so importing a provider on edge does not pull `@kuralle-syrinx/ws/node`.
- Use a PCM-only edge browser transport. The existing Opus browser transport still lives on the Node subpath because its `@evan/opus` loader is not edge-safe.
- Represent Durable Object alarm callbacks with stable scheduler keys. The DO scheduler persists deadlines in `ctx.storage.sql` and exposes `runDue()` for `alarm()`.

Root Causes Fixed
- `WS-NODE-01`: provider plugins no longer statically import `@kuralle-syrinx/ws/node`; Node defaults resolve lazily at initialization time only when no socket factory was injected.
- `WS-01/02/03`: Workers inbound upgrade now uses `WebSocketPair` through `@kuralle-syrinx/ws/workers`, with a controlled managed socket for Durable Object hibernation callbacks.
- `NATIVE-01/FS-01`: `@kuralle-syrinx/silero-vad/workers` uses `onnxruntime-web` and model bytes/URL instead of `onnxruntime-node` and filesystem paths.
- `NATIVE-02` static-build prong: Smart Turn no longer statically imports `@huggingface/transformers`; feature extraction is loaded during predictor initialization.
- `TIMER-*`: long-lived watchdog/fallback/playout/keepalive timers route through the `Scheduler` seam; the Workers implementation persists alarm deadlines in DO SQL.
- `STATE-01/02`: the Workers app uses `DurableObjectSessionStore` backed by `ctx.storage.sql` for session metadata and resume-window retention.
- `WS-05/06/NODE-01`: the new Workers entrypoint imports only the edge subpath, so Node graceful-drain and `wsServer.clients` remain Node-only.

Verification Notes
- `pnpm -r typecheck` passed.
- `pnpm -r test` passed after replacing Telnyx fixed sleeps with condition waits; the failing recursive runs exposed pre-existing timing-sensitive tests under workspace load.
- `bash scripts/verify-edge-bundle.sh` passed for the worker bundle and a Cartesia provider bundle.
- `pnpm --filter @kuralle-syrinx/server-workers test` passed, including Miniflare/workerd WebSocket turn smoke and DO scheduler/store tests.
- `pnpm --filter @kuralle-syrinx/server-workers exec wrangler deploy --dry-run` passed with the DO binding and migration config.

---

## Live wiring, keep-alive, recording & deployment (follow-up)

### Live session (replaces the stub)
- `live-session.ts` `createLiveVoiceAgentSession(env)` builds a real `VoiceAgentSession`:
  Deepgram STT (`nova-3`) + AISDK OpenAI bridge (`gpt-4.1-mini`) + Cartesia TTS (`sonic-3`),
  each constructed with `createWorkersSocket` so provider connections use the Workers
  fetch-upgrade socket (no Node `ws`).
- Turn-taking is owned by Deepgram endpointing (`endpointingOwner: "provider_stt"`), so no
  Silero VAD / Smart Turn ONNX runs on the edge hot path. The Silero `onnxruntime-web`
  path exists (`silero-vad/workers.ts`) but is not wired into the live session.
- Provider secrets come from the DO `Env` (`DEEPGRAM_API_KEY`, `OPENAI_API_KEY`,
  `CARTESIA_API_KEY`).

### Outbound socket scheme fix
- `createWorkersSocket` normalizes `wss://`→`https://` (and `ws://`→`http://`) before
  `fetch()`. workerd's `fetch()` rejects the `ws(s)` scheme; provider endpoint URLs are
  `wss://`, so every outbound provider socket failed before this fix. Surfaced by the live
  turn (`stt` init: "Fetch API cannot load: wss://api.deepgram.com/...").

### Keep-alive & idle close (`edge.ts`)
- A self-re-arming heartbeat (`keepAliveIntervalMs`, default 15s) runs while a connection is
  open. On the Workers DO scheduler the alarm keeps the Durable Object alive during an active
  call — the equivalent of `cloudflare/agents` `keepAlive()`, built on our `Scheduler` seam.
- `idleTimeoutMs` (default 60s) closes half-open clients that have sent no message in the
  window — the dead-client detection the standard `WebSocketPair` cannot do via a ping frame.
- Cancelled on close so an idle DO can be evicted. Covered by `edge.test.ts`.

### R2 call recording
- `edge.ts` exposes a runtime-agnostic `EdgeRecorder` sink (taps `user.audio_received` +
  `tts.audio`, `finalize()` on close) — no storage types in the transport layer.
- `server-workers/r2-recorder.ts` `R2EdgeRecorder` buffers PCM16 (memory-capped) and
  on call end writes to the `RECORDINGS` R2 bucket:
  - `conversation.wav` — the **full conversation in one stereo file** (user = left,
    assistant = right), time-aligned by wall-clock byte offset so the assistant sits at its
    real position instead of stacked at 0. Mirrors the Node `voice-recorder` conversation track.
  - `user.wav` / `assistant.wav` — the per-speaker stems.
  - `manifest.json` — durations / byte lengths / truncation flags.
  Wired optionally in the DO (only when the bucket is bound). `GET /recordings?sessionId=`
  lists a session's objects. Cloudflare's `withVoice` persists transcripts to SQLite but not
  raw audio, so this is additive.

### Deployment
- `wrangler.jsonc` binds `VOICE_CONVERSATIONS` (DO, SQLite migration `v1`) and `RECORDINGS`
  (R2 bucket `syrinx-voice-recordings`), `nodejs_compat`.
- Deploy: `pnpm --filter @kuralle-syrinx/server-workers exec wrangler deploy`; secrets via
  `wrangler secret put`.
- **Live-verified on real Cloudflare infra:** a deployed turn transcribed the fixture exactly
  ("Can you help me reset my student portal password?"), returned Cartesia TTS, and wrote
  `user.wav` (3.17s) + `assistant.wav` (8.08s) + `manifest.json` to R2.
- Local opt-in live turn: `pnpm --filter @kuralle-syrinx/server-workers test:live`
  (`SYRINX_LIVE_WORKER_TEST=1`); default `pnpm -r test` skips it so CI stays deterministic.

### Known residual
- The inbound DO path uses hibernation (`acceptWebSocket`); the session's internal
  `setTimeout` watchdogs run only while the DO is resident (correct for an active call, not
  across hibernation between turns).
