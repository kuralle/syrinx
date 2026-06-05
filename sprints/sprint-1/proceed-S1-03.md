# Proceed Evidence — `S1-03` live worker turn through the generalized bridge (AI SDK)

> **Manager artifact — Phase A.** S1-03 is manager-run verification + deploy (no IC story).

---

## Story

- **Id:** `S1-03`
- **Commits:** none (verification + deploy only; code unchanged since `ad65e10`). Deployed Version `cc9236aa-1df5-4307-b4b1-4f6a653e053c`.

---

## Proceed checklist (manager-run gates)

- [x] **Edge bundle clean:** `bash scripts/verify-edge-bundle.sh` → exit 0 (`edge bundle clean: .edge-build/worker.js …`). The re-home + the new `@ai-sdk/openai` import at the worker call site pulled no Node-only deps into the edge build.
- [x] **Opt-in live worker turn (workerd/miniflare):** `SYRINX_LIVE_WORKER_TEST=1 pnpm --filter @asyncdot/voice-server-workers test` → 10/10 pass, incl. *"drives a real audio turn through Deepgram + OpenAI + Cartesia in workerd"* (transcript: *"Can you help me reset my student portal password?"*).
- [x] **Deployed `/ws` turn (real Cloudflare edge):** deployed via `wrangler deploy` (Version `cc9236aa`, DO `VOICE_CONVERSATIONS` + R2 `RECORDINGS` bindings intact, Startup 40 ms); `GET /health` → `ok`; a real audio turn over `wss://syrinx-voice-server-workers.mithushancj.workers.dev/ws` (`.handoff/deployed-turn-proof.mjs`) returned:
  - transcript: *"Can you help me reset my student portal password?"*
  - TTS audio: **141,236 bytes** (binary `tts_chunk` frames)
  - `stt_output` + `tts_chunk` both observed.
- [x] **Latency gate (M3):** the local harness `smoke:websocket-interactive` (short fixture, `SYRINX_WS_MAX_TURNS=1` per the credit directive) — LLM-TTFT 2890/3236 ms (from S1-02; code unchanged since) — within the S1-00 band (P50 ≤ 3920 / P95 ≤ 4530). The deployed turn is functional proof only, **not** the latency gate (RFC §7a — deployed turn too network-noisy to gate on).

**Verdict:** `PROCEED` — Phase A complete (all 4 Sprint-1 stories have PROCEED).

---

## One-line summary

Re-homed `ReasoningBridge` is live on the deployed Cloudflare worker (Version `cc9236aa`) — a real `/ws` turn transcribed + returned 141 KB of TTS; edge bundle clean; workerd miniflare turn green; latency within the S1-00 band.

---

## Notes

- The deployed-turn driver (`.handoff/deployed-turn-proof.mjs`) is a one-off proof tool (gitignored `.handoff/`), speaking the worker WS protocol from `worker-runtime.test.ts` (`{type:"audio",audio:base64,sampleRateHz,sequence}` → `stt_output`/`tts_chunk`). It is not production code; if a repeatable deployed-turn smoke is wanted later, promote it to `examples/.../scripts/` (backlog).
- Deploy authorized by the user this session (outward-facing action surfaced before running).
- The interactive smoke is local-only (`createVoiceWebSocketServer` + `127.0.0.1`); it cannot target the deployed worker — hence the standalone driver for the deployed-edge proof.
