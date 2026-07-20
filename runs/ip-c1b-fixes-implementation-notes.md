# IP-C1b review-fixes — implementation notes

Fixes for the code-review findings on `feat/interaction-policy-vap` (the codex C1b/IP-VAP/C6 work),
plus an adversarial second pass. Manager session, autonomous-stand.

## Locked intent

Fix the *real* defects from the review, resolve the two uncertain ones by evidence rather than
guessing, and adversarially hunt the changed code for more — all behind a green gate with regression
tests. No behavior-preserving claim without a test that pins it.

## What shipped (3 real bugs fixed, root-cause)

### #1 — user audio was mislabeled 16 kHz (correctness)
`observeAudioFrame` stamped `sampleRateHz: 16_000` unconditionally, while every transport resamples
inbound audio to a **configurable** rate (`inputSampleRateHz` / `engineSampleRateHz`, default 16000).
`DualTurnPredictor.resample()` keys its resampler off that field, so a non-16k deployment fed
wrong-rate audio to VAP/SmartTurn. Asymmetric with the assistant `playout_tick`, which already passed
the true rate.
- **Root-cause fix:** made the packet carry its rate. Added optional `sampleRateHz?` to
  `UserAudioReceivedPacket`; the session consumes `pkt.sampleRateHz ?? 16_000`; all **8** production
  emitters (edge, edge-twilio, twilio, telnyx, smartpbx, index ×2) now declare the rate they resample
  to. Optional field ⇒ backward-compatible (omitted = legacy 16k).
- **Test:** `voice-agent-session.test.ts` — "threads the packet's true sample rate … (not a hardcoded 16k)".

### #3 — a policy-committed `take_turn` could silently drop the turn (correctness)
When an injected policy committed to a turn but STT produced only an *interim* (no final),
`InteractionCoordinator` dropped it: `armTakeTurn` called `tryScheduleTurnComplete` before any text
existed, the early guard bailed, no timer was scheduled, and `handleSttInterim` didn't reschedule.
- **Root-cause fix (two parts):** (a) removed the pre-schedule guard so the finalize timer is
  **anchored at the policy's commitment**, not at first-text; (b) the fire-time callback now falls back
  to the latest interim (synthesizing a `confidence:0` transcript) when no final ever arrives, so a
  committed turn is never lost. Still bails only when there is genuinely nothing (no final, no interim).
  Verified `handleTurnComplete` has no confidence filter, so `confidence:0` completes safely.
- **Tests:** coordinator — "completes a committed take_turn from the latest interim…" and
  "does not complete … when neither a final nor an interim ever arrives".

### #4 — `stop()` could leak an interaction-playout timer (cleanup/correctness)
`stop()` cancelled interaction-playout timers by iterating `firstTtsAudioFired`, a set cleared
per-turn (`handleTurnComplete`), while the timer is keyed independently on the tts.done context. With
telephony contextId reuse the sets diverge, and there is no global scheduler clear, so the cancel loop
missed live timers (post-`stop` callback into a disposed coordinator).
- **Root-cause fix:** dedicated `pendingInteractionPlayoutTimers` set maintained by
  `scheduleInteractionPlayoutTick` / `cancelInteractionPlayoutTick` helpers (centralizes the mechanism
  that was scattered across 4 sites); `stop()` cancels that set.
- **Test:** session — "cancels a pending interaction playout timer on close even after its turn
  completed"; the mid-test assertion proves the `firstTtsAudioFired` divergence is real.

## Investigated → NOT defects (evidence, no code change)

### #2 — policy-level `userSpeaking` change is redundant, not a regression (PROVEN by differential test)
The review flagged that removing the early `return` in `handleVadSpeechStarted` makes
`RuleBasedInteractionPolicy` set `userSpeaking=true` on every speech start (not just barge-in),
suppressing the delegate `mm_hmm` cue.
- **Confirmed via git** (`dfa1ee2`): the session sets its **own** `this.userSpeaking = true` at line 795,
  *before* the removed early `return` at line 818 — i.e. it was set on every speech start in the OLD
  code too. It feeds the coordinator via `isUserSpeaking` (line 401).
- **Proven via a runnable differential** (temp `_diag_2.test.ts`, since removed): reproduced both the
  OLD wiring (policy never receives `vad_speech_started`, session `userSpeaking`=true) and the NEW
  wiring (policy receives it), then fired `delegate_state delayed`. **Both emit ZERO
  `interaction.backchannel` packets** — the cue never plays over a speaking user in either version.
- **Only difference (observability, not behavior):** OLD suppresses at the coordinator, emitting
  `backchannel.candidate` + `backchannel.suppressed_user_speaking` metrics; NEW suppresses at the policy
  (short-circuits before the coordinator), emitting neither. So a metrics monitor would see fewer
  suppression events — harmless, arguably cleaner. **Not a functional defect.** No revert (reverting
  would re-open the injected-policy path, which *needs* the delivered speech-start events).

### #5 — SmartTurn output is a PROBABILITY; threshold 0.5 is correct (PROVEN by running the model)
The predictor returns the ONNX `"logits"` output and thresholds at 0.5 with no explicit sigmoid. The
review (and deepwiki) left this ambiguous — the export names the output `logits`, but upstream
`inference.py` comments "ONNX model returns sigmoid probabilities."
- **Settled empirically** by running the actual bundled `smart-turn-v3.2-cpu.onnx` (via
  `onnxruntime-node`, throwaway probe now removed) across a 100× input-magnitude sweep. Output shape
  `[1,1]`; values stayed pinned in **[0.9228, 0.9889]** for input scales 0→50 and never escaped (0,1).
  That saturation is the unmistakable signature of a **terminal sigmoid** (a raw-logit head would blow
  up at scale 50). The graph contains exactly one `Sigmoid` op — it is the output op.
- **Conclusion:** the `"logits"` output is a **probability**. Thresholding at 0.5 is correct, and
  feeding it into `confidenceToWaitMs` as a [0,1] confidence is properly calibrated. **Not a defect** —
  and the diff's new confidence→wait curve is sound because the confidence is a genuine probability.
  (Behavior shared with the shipped `PipecatEOSPlugin`.)

## Adversarial hunt — scope + conclusion

Hunted the full C1b/IP-VAP/C6 diff for additional bugs, focused on the densest new code:
- **`LocalVapPredictor` / `dualturn-predictor.ts`** — reset-mid-`push` orphans the context object across
  awaits, but the `VapInteractionPolicy` serializes push per contextId (`inferenceChains`) and the
  epoch guard discards stale results, so the orphaned mutation is harmless and the next turn gets a
  fresh context. `PcmSampleQueue` ring buffer + overflow/underflow guards are correct; overflow-throw is
  intentional backpressure. `hasReadyWindow` drain loop is bounded (steady-state ~1 window buffered).
- **VAP epoch/reset** (`index.ts`) — traced enqueue/reset/finally interleavings (reset-in-flight,
  contextId reuse, no-new-frame-after-reset); revoke semantics hold, no epoch leak.
- **`RollingFeatureBuffer.snapshot`** — chronological ring copy is correct.
- **`SmartTurnInteractionPolicy`** — boundary-sequence staleness guard and fallback/close cleanup are
  correct (minor: uses raw `setTimeout` not the injected scheduler — consistency nit, not a bug).
- **Coordinator/session hot paths** — no double-completion (injected policy is sole endpoint owner),
  `transcriptsByContext` is bounded (cleared on turn reset), synthesized-transcript path is safe.

**Conclusion:** beyond #1/#3/#4, no additional slam-dunk correctness bug surfaced. Recording that
honestly rather than inflating the count. Non-defect nits (SmartTurn raw setTimeout; `mapTurnHeads`
`-2` frame indexing which the C6 AUC .762 confirms is meaningful) left as-is.

## Verification

- `pnpm -r typecheck` — clean except the known pre-existing `run-studio-bargein-e2e.ts`
  (missing `playwright-core`), documented in SESSION-HANDOFF.
- `@kuralle-syrinx/core` — 278 tests (incl. 3 new regression tests).
- `@kuralle-syrinx/server-websocket` — 241 tests (8 emitter edits).
- `@kuralle-syrinx/vap` 8 · `@kuralle-syrinx/pipecat-smart-turn` 33 · `@kuralle-syrinx/realtime` 51.

## Files touched

Core: `packets.ts`, `voice-agent-session.ts`, `interaction-coordinator.ts`,
`voice-agent-session.test.ts`, `interaction-coordinator.test.ts`.
server-websocket: `edge.ts`, `edge-twilio.ts`, `twilio.ts`, `telnyx.ts`, `smartpbx.ts`, `index.ts`.
