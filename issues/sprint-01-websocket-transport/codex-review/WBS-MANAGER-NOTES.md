# WBS Execution — Manager Notes

Autonomous-manager execution of `WBS-FINAL.md` (the validated Gemini-review backlog).
Worker: **cursor `--model auto`**, one delegated pass per priority, each fix TDD
red-green. Manager (Claude Opus 4.8) reviewed every diff, caught/fixed regressions, and
verified the suite at each priority's quiescent end-state.

## Outcome
- **19 commits** (`6ca5940 … 1d124b2`), P0×4 + P1×5 + P2×7 + P3×3 — every CONFIRMED-REAL
  and actionable PARTIALLY-REAL item from the WBS.
- `pnpm -r typecheck` exit 0; `pnpm -r test` **green ×2** (509 tests, 0 failures).
- No forbidden files touched (GEMINI-EXTERNAL-REVIEW.md / baselines / voice-bridge-aisdk
  untouched); name-only commits throughout.

## Per-priority

**P0 (high) — 4 commits.** `6ca5940` filler word-boundary (verified by running it:
`Some`/`Wellness` preserved), `87e6ff9` jitter-buffer barge-in schedule reset (timing now
asserted), `4b905b4` primary-speaker gate (enrollment-on-speech, echo-dominance margin,
turn-lockout), `6f06be6` Opus→PCM downlink capability handshake.

**P1 (high) — 5 commits.** `3cc9361` SessionStore serialized-lease/force-evict/update-seam/
metrics-resume, `4c79df7` stateful per-stream resampler (per-connection `Map`, stateless
kept for whole-buffer; continuity test proves no boundary ringing), `401e29c` voice-ws
`abortOpen` dispose-settle + verify-timer clear, `2803831` graceful-drain close-settle,
`5d48697` Smart-Turn shortcut/defer-finalize timing.

**P2 (med) — 7 commits.** pacer deadline-by-actual-duration, browser metrics
(unthrottled start / downlink jitter / lead init), Cartesia offset-clear + sample-derived
timestamps, cooperative upgrade routing (`listenerCount>1`), connect-during-CLOSING queue,
transport-host pre-closed guard, latency-filler cleanup on error paths.

**P3 (low) — 3 commits.** bounded test HTTP teardown, dead-code removal (semantic), hold
uplink until codec negotiation.

## Manager interventions (review caught these)
- **P0-3 regression caught:** the gate fix initially broke the existing, correct
  *"suppresses sustained bystander barge-in"* test (bystander committed instead of
  suppressed) and was committed with a red suite. Root cause: new enrollment-gating
  required `vad.speech_started`, which the test's enroll helper didn't emit → profile
  never enrolled → gate bypassed. cursor's follow-up fixed the **helper** (not the
  assertion) — verified legitimate, suite green. Confirmed it was not masking.
- **Mid-flight false-reds:** `pnpm test` against cursor's mid-edit working tree produced a
  transient voice-ws failure; re-verifying at the quiescent at-rest HEAD showed green.
  Discipline adopted: authoritative suite runs only after the worker fully exits + tree clean.

## Known minor follow-up (not blocking)
- **P0-3 metric noise:** sustained non-primary speech now re-emits `interrupt.suppressed_
  non_primary` per `vad.speech_activity` frame (the lockout fix keeps `pending` alive and
  re-evaluates). Functionally correct (no lockout, bystander still suppressed) but emits N
  background metrics/turn instead of 1. Candidate cleanup: throttle re-emission / re-window.

## Not done (by design — from WBS "No Action")
Already-fixed: WT-08 per-path cap (= CR-03). False-positive: VE-04 NaN timestamps (JSON
can't carry NaN). Unproven design-theory (revisit with fixtures, not bugs): VE-02
fingerprint over-fit / RMS sensitivity / cosine bias / stale-profile; VE-03 filler splice
prosody. These remain intentionally untouched.
