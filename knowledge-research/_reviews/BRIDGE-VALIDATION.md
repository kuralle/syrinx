# Bridge Validation — build/reconcile/ vs Syrinx packages/

**Method.** Workflow `wzx7wsya2`: one adversarial agent per bridge opened every `packages/...:line` citation and **grepped the codebase to disprove every "missing/net-new" claim**. Findings classified by consequence. Per-bridge verdicts durable in `_reviews/bridge-verify/*.json`.

**Totals:** 9 bridges · 73 citations + 60 absence-claims checked · 109 aligned · **5 WRONG · 8 MISCITED · 0 UNVERIFIABLE**.

**`build-wrong-thing` (false "X missing" → build something nonexistent): NONE.** Good — no bridge would send an IC to build a feature that doesn't exist.

## The 5 over-stated gaps (bridge claimed net-new; Syrinx already has it) — FIXED + manager-verified
Following these as written would have **rebuilt existing, already-tested code.** Each corrected in the bridge to point only at the genuinely-missing delta:

1. **VE-01.1 — audio-payload validation.** `validateSyrinxAudioEnvelope` already throws on channels≠1 / empty-Opus / odd-PCM16 (`packages/voice/src/audio-envelope.ts:71-111`). The bridge's `assertAudioPayload` duplicated it → reframed VE-01.1 as *reuse/extend*; genuinely-missing = per-adapter declared-vs-actual (VE-01.2, correctly absent).
2. **VE-01 — ready-frame negotiation.** Ready frame already emits sample rates / encoding / codecs / channels (`voice-server-websocket/src/index.ts:295-312`). Only **target frame duration** + a no-silent-switch test are new.
3. **VE-06.5 — drain policy.** Graceful drain is implemented **and tested** (`index.ts:362` `close({graceful,drainDeadlineMs})`, `outbound-playout-pipeline.ts:125`, tests `graceful-drain.test.ts:159` graceful + `:205` forced). Narrowed to **SIGTERM/SIGINT wiring** (grep-confirmed: no `process.on('SIGTERM')` calls the drain anywhere).
4. **VE-06.4 — heartbeat.** Transport WS heartbeat exists (`websocket-lifecycle.ts:28`, `DEFAULT_HEARTBEAT_INTERVAL_MS=30_000`). Narrowed to **input-audio cadence watchdog + recovery**.
5. **VE-09.4 — VAQI.** Missed-response window already exists (`vaqiMissedResponseMs` default 4000, `voice-agent-session-util.ts:70,113`) + all 3 constituents emit. Narrowed to the **rollup formula + tolerance bands** only.

(All 5 manager-verified directly against the code.)

## The 8 MISCITED — citation-precision (right claim, wrong line) — ALL FIXED
A wrong line is a small landmine for an IC who opens it and sees the wrong code, so all 8 were corrected in the bridges:
- VE-01: `user.audio_received` push `index.ts:599`→`:615`; Twilio push `twilio.ts:303`→`:307` (`:303` = base64 decode); Deepgram split into `:257` `sendAudio` / `:131` KeepAlive / `:272` Finalize.
- VE-03: TurnArbiter routing `voice-agent-session.ts:571`→`:577` (`:571` = TTS-context gate); `interrupt.detected` emission `turn-arbiter.ts:150`→`:183` (`:150` = `tryCommit` gate).
- VE-04: Telnyx server `telnyx.ts:115`→`:134` (`createTelnyxMediaStreamServer`); reorder buffer `:328`→`:330`.
- VE-05: `scripts/run-tracer-bullet.ts` does not exist → corrected to extend `run-streaming-cascade.ts`/`run-full-cascade.ts`.
Full evidence in `_reviews/bridge-verify/*.json`.

**Conclusion:** the plan is **not founded on false premises.** No phantom features; the only correctness issue was 5 gaps over-stated as net-new (now narrowed so ICs reuse the existing tested code instead of rebuilding it).
