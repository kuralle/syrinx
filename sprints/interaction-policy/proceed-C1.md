# Proceed evidence — `IP-C1` InteractionPolicy seam + coordinator + RuleBasedInteractionPolicy (barge-in)

**Verdict:** **PROCEED** (round 1 — no HOLD)
**Manager:** Opus 4.8 (1M), 2026-07-09
**Commit under review:** `a53f2d2` `[IP-C1]` on `plan/interaction-policy`
**Worker:** grok
**Manager regression guard added:** `2d…` (separate commit — see below)

## What was verified (re-run, exit codes authoritative)

- **Manager re-run** (not the worker's word): `pnpm --filter @kuralle-syrinx/core typecheck` exit 0;
  `pnpm --filter @kuralle-syrinx/core test` exit 0 — **247 tests / 25 files** (241 baseline + 6 new),
  matching the proof json (`.handoff/proof-ip-c1.json`, both claims exit 0).
- **Guard tests byte-UNCHANGED** (REQ-8, the behavior-preservation contract): `git diff` on
  `turn-arbiter.test.ts`, `turn-arbiter.characterization.test.ts`, `voice-agent-session.test.ts` is
  **empty**. The characterization transition table and the full session barge-in suite pass unedited.
- **Diff is surgical** (653 insertions across the intended files only): `interaction-policy.ts`,
  `interaction-coordinator.ts`, `policies/rule-based.ts` (+ 2 tests), `turn-arbiter.ts` (+sink),
  `voice-agent-session.ts` (wiring), `index.ts` (exports).

## Read the hunks — correctness confirmed

- **Sink (turn-arbiter.ts):** `onInterrupt?` dep + `decideInterrupt` routes to sink-if-present-else
  `emitInterruptDetected`. Both autonomous-commit sites (`onSpeechStarted` minInterruptionMs≤0 path;
  `tryCommit` terminal) now call `decideInterrupt`. **No-sink default = byte-identical** → the bare-arbiter
  unit test stays green.
- **No double-drive:** the only remaining `this.turnArbiter.` calls in the session are the executor
  methods — `clear` (461), `commitClientInterrupt` (495), `emitInterruptDetected` (1044). Every
  decision-driving call now flows through `this.interaction.observe(...)`.
- **Gating preserved:** `observeSttForBargeIn` sets `interruptedContextId` only when
  `provider_stt && text.trim() && active TTS` — identical to the old `maybeBargeInFromProviderStt` guard;
  `noteInterimEvidence` still runs regardless (evidence recording), barge-in still gated.
- **Ordering preserved:** the commit path pushes the 3 Background metrics, then the sink buffers the
  interrupt, then the coordinator's `apply` pushes the Critical `interrupt.detected` — same push sequence,
  same packet (`source:"vad"`), same synchronous call stack (negligible latency; REQ-9 unaffected).
- **The deferred-audio concern (checked):** `observeBargeInAudio` can commit inside the arbiter. grok
  handled it: the policy sets a `bargeInAudioConsumed` flag AND buffers the interrupt; the coordinator's
  `observeBargeInAudio` runs `observe()` (which drains + applies the interrupt) then reads
  `takeBargeInAudioConsumed()` for the enrollment-skip boolean. The "defers immediate cut until vad.audio"
  characterization case (minInterruptionMs=0, enrolled profile) exercises exactly this and is green.

## Adversarial repro (manager-built, promoted to a permanent guard)

The 6 new tests cover the coordinator mapping + policy parity/suppression, but backchannel **suppression**
was tested only at the policy level (vad-driven) and the session **provider-STT** path only for *commit*
(session test 1196). I added `voice-agent-session.test.ts` →
`"suppresses a backchannel provider-STT interim through the interaction seam (IP-C1 regression)"`:
provider_stt + assistant speaking + two sustained "okay" interims → asserts **no `interrupt.tts`** and
metric `interrupt.suppressed_backchannel`. This drives the full reshaped chain
(`observeSttForBargeIn → coordinator → policy → arbiter`). It is discriminative: if the reshape had
mis-ordered `noteInterimEvidence` vs `onProviderSttEvidence` (the latter's `transitionToPending` resets
`latestInterimText`), the backchannel text would be empty at `tryCommit` → an interrupt would fire → the
test fails. It **passes** → suite now **248/248** green, typecheck 0.

## Minor note (not a blocker)
`InteractionCoordinator.observeBargeInAudio` uses `policy instanceof RuleBasedInteractionPolicy` to read
the consumed-flag, falling back to `executor.observeBargeInAudio` for other policies. Pragmatic for C1;
revisit when a second policy (Vap) lands so the boolean rides the seam rather than a type check.

## Decision
**PROCEED.** The seam is real (a future Vap policy returns the same `interrupt` decisions through the same
coordinator executor), behavior is preserved (guards unchanged + green + a new session-level suppression
guard), and the diff is surgical. IP-C1 done.
