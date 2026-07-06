# Failure-Modes Runbook & Production-Readiness Checklist

> Symptom → cause → check → fix, for operators running Syrinx and maintainers debugging
> live calls. Sources: `docs/voice-engine-behavior-spec.md` (the invariant catalog),
> `syrinx-critical-review-implementation-notes.md`, the v4.0.0 correctness sweep, and the
> 2026-07-07 teardown. Status is as of v4.1.0 + the ws reconnect fix.

## 1. Live-call symptom table

| Symptom | Likely cause | Check | Fix / status |
|---|---|---|---|
| Agent answers turn 1 of a phone call, then goes deaf/mute | Telephony adapter reusing one `contextId` for the whole call; STT/TTS retire a context once its turn completes (spec T1/T2) | Are you on ≥4.0.0? `turn.change` events firing per turn? | **Fixed v4.0.0** (per-turn `<base>-t<n>` rotation on twilio/telnyx/smartpbx). If seen on ≥4.0.0, capture packet log and file — the fix is code-confirmed but **not field-confirmed on a live carrier** |
| Speech sounds 3× too fast (STT garbage) or 3× too slow (client playback) | Opus wire-format mislabeling: uplink double-resample / downlink labeled 16k at 48k codec rate (spec A1) | Version <4.0.0? Custom client pinned to the old labels? | **Fixed v4.0.0** (breaking — consumers pinned to buggy shapes must update). Regression test asserts decoded-ms ≈ sent-ms |
| Assistant keeps talking over the caller after barge-in; remembers words the caller never heard | Barge-in truncation using generated text instead of heard prefix; client not reporting `playout_progress` (spec B2) | Is the client sending `playout_progress`? (browser-client ≥4.0.0 does) | **Fixed v4.0.0** end-to-end; custom clients must implement `playout_progress` to get heard-prefix truncation |
| Call hangs up when the model hits token cap / non-`stop` finish | `validateFinalFinishReason` used to throw fatally (spec L2) | — | **Fixed v4.0.0**: `length` accepts truncated reply; other finishes → recoverable `llm.error`, fallback line, session stays up |
| "Stop"/interruption during the thinking gap (before any audio) is ignored | Thinking-phase barge-in was a no-op (spec B3) | — | **Fixed v4.0.0** (`requestClientInterrupt` aborts in-flight generation) |
| Phone caller hears pure silence between turns and hangs up ("call died") | Digital silence on the PSTN leg reads as dead line | Which carrier path? | **edge-twilio: fixed v4.1.0** (idle comfort-noise frames). **Node telephony carriers: OPEN** (`SESSION-HANDOFF:55-56` — needs per-carrier background-frame encoder) |
| Provider STT/TTS sockets accumulate; provider bill grows across hangups | `edge-twilio` released sessions without decrementing `connectionCount` (spec R1) | Provider dashboard concurrent-connection count vs live calls | **Fixed v4.0.0** |
| Durable Object OOM on long recorded calls | R2 recorder buffered the whole call in DO RAM (spec R3) | Recording long calls with R2 bound? | **Fixed v4.0.0** (multipart streaming to R2) |
| First utterance after a provider reconnect is rejected / provider errors on reconnect | Frames sent during the reconnect verify window hit the new socket **before** the config frame (`@kuralle-syrinx/ws` race) | Provider logs show audio-before-config on reconnect | **Fixed 2026-07-07** (`established` gate in `WebSocketConnection.send`; deterministic regression test in `packages/ws/src/replay.test.ts`) |
| Turn never completes on a noisy line (`speech_final` never fires) | Endpointing wedge | Deepgram config includes `utterance_end_ms` backstop? | **Fixed v4.0.0** (gap-based backstop; enabled on edge cascade) |
| Surprise provider bills / strangers talking to your agent | Voice endpoints are **unauthenticated by default** | Is an `authorize` hook wired? (reject → 4401) | **By design — operator action required.** See checklist §3 |
| Turn latency feels slow; users talk over the agent | LLM TTFT dominates v2v (P50 2.1–3.6s measured vs ≤800ms budget) | `turn_latency` events: which hop is fat? | **OPEN (the #1 product gap).** Mitigations shipped: latency filler, speculative generation (opt-in, Flux eager mode), bi-model front. Root fix (hedging/adaptive routing) is Draft RFC `rfc-reasoner-latency.md` |
| Realtime session loses context after network blip / DO eviction | Resume machinery | ≥4.0.0? `durableHistory` on? | **Mostly fixed v4.0.0** (durable reasoner sessions, Gemini Live resumption handles, OpenAI history replay). Full realtime history-restore on reconnect: **PARTIAL** (spec R2) |

## 2. Open-risk register (check before every release; prune when closed)

| Risk | Severity | Status |
|---|---|---|
| 39 untriaged dependabot vulnerabilities on the default branch | High (published to npm) | OPEN — untriaged (`SESSION-HANDOFF:61`) |
| v2v latency 3–4× over the 800ms budget on default cascade | High (product thesis) | OPEN — `rfc-reasoner-latency` Draft; hedge/route files don't exist |
| Telephony P0 fixes never reproduced on a live carrier call | Medium | OPEN — high confidence from code; needs one field call per carrier |
| `google` STT targets a wss endpoint GCP v2 may not expose (gRPC) | Medium (package may not work at all) | OPEN — treat as spike; do not advertise until live-verified |
| Naive linear-interp resampler still on some audible paths (spec A2) | Low-medium | PARTIAL — FIR exists, not swapped everywhere |
| Deepgram `stt.test.ts` flaky under full parallel load | Low (test trust) | OPEN — root-cause like the ws race (2026-07-07) rather than retry-loop it |
| TTS `finish_timeout_ms` wedge-guard: early `tts.end` vs late audio ordering | Low | OPEN — needs a repro before touching drain ordering (`SESSION-HANDOFF:57-58`) |
| Backchannel classifier is English-only (spec B4) | Low (locale-dependent) | OPEN — Sinhala/multilingual gap |
| ELEVENLABS advertised in README env; no package exists | Low (trust) | OPEN — remove from README or ship the package |

## 3. Production-readiness checklist (before pointing real traffic at a deployment)

- [ ] **Auth**: `authorize` hook wired on every WS host (browser + telephony); Twilio
      webhook validated with `validateTwilioSignature`. Unauthenticated endpoints burn
      provider credit for anyone with the URL.
- [ ] **Cost bounds**: provider-side concurrency/spend limits set (Deepgram/OpenAI/
      Cartesia dashboards); `connectionCount` admission limit configured on the host.
- [ ] **Observability**: decide eyes-open — core ships only no-op/in-memory
      `MetricsExporter` implementations (no Prometheus/OTel package exists as of v4.1.0).
      Minimum viable: consume `turn_latency` + `delegate_*` session events into your own
      sink; alert on TTFA P95 and error-rate.
- [ ] **Scale shape**: Node host is single-process, in-memory session state — one box, or
      session-affinity you build yourself. The horizontal path is the Workers deployment
      (one DO per call). Choose deliberately.
- [ ] **Recording**: if R2 recording is on, confirm bucket lifecycle policy + the
      recording consent posture for your jurisdiction.
- [ ] **Latency budget**: run the latency gate against YOUR provider/model mix
      (`docs/latency-budget.md`); the defaults' numbers don't transfer.
- [ ] **Reconnect drills**: kill the provider socket mid-call in staging; verify
      config-first ordering, replay, and resume behave (the 2026-07-07 race shipped in
      every version ≤4.1.0 — make sure you're past it).
- [ ] **Field confirmation**: one real phone call per telephony carrier you enable,
      minimum two turns + one barge-in, before go-live (see risk register).

## 4. Debugging a live call — where to look

1. `turn_latency` session events — per-turn TTFA decomposition (`eouDelayMs` /
   `llmTtftMs` / `ttsTtfbMs`, `fillerUsed`) tells you which hop is lying.
2. `delegate_query` / `delegate_result` events — what the reasoner was asked and answered
   (`grounded` flag = did it actually consult a tool).
3. The recorder's stereo `conversation.wav` (user left / assistant right, time-aligned) —
   the ground truth for "who spoke when," including barge-in disputes.
4. `debugEvents` / `allPackets` bus taps (bounded since v4.0.0 — safe to leave attached).
5. Wire messages `tool_call_started/delayed/complete/failed` — the caller-perceived
   thinking timeline.
