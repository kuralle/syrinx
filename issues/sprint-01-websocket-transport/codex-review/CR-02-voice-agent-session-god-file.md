# CR-02 — `voice-agent-session.ts` remains a 1688-line god file

- **Status:** Filed (not fixed in this run)
- **Severity:** Medium
- **Area:** core architecture / maintainability / change risk

## Problem / Evidence

`VoiceAgentSession` remains 1688 lines with many unrelated responsibilities in one class.

- `packages/voice/src/voice-agent-session.ts` line count: `1688`
- Handler clusters include VAD/barge-in, STT flow, LLM flow, TTS playout clocking, interruption policy, and watchdog timers in one surface.

## Root cause

Incremental hardening features were layered into one orchestrator class without extracting focused modules.

## Proposed solution

Extract a boring, low-risk decomposition in staged PRs:

1. `session-turn-state.ts` for active context/turn bookkeeping.
2. `session-interruption-policy.ts` for VAD/primary-speaker/interrupt gating.
3. `session-tts-playout-clock.ts` for playout progress and release timers.
4. `session-watchdogs.ts` for STT/VAQI/TTS timeout state.

Keep `VoiceAgentSession` as orchestration glue only.

## Acceptance criteria

- [ ] `voice-agent-session.ts` reduced below 1000 lines.
- [ ] Extracted modules have focused tests and preserve existing behavior.
- [ ] No regressions in `@asyncdot/voice` tests.

## Test plan (TDD + smoke)

- Characterization tests around interruption, playout release, and timeout behavior before extraction.
- `pnpm --filter @asyncdot/voice test` after each extraction step.

## Definition of done

Session orchestration is split into focused modules with equivalent behavior and lower change-risk surface.

## Why not fixed here

This is a structural refactor spanning multiple risk-heavy subsystems. It is fixable, but not safely completable inside this review/repair run without a dedicated decomposition PR series and characterization test expansion.
