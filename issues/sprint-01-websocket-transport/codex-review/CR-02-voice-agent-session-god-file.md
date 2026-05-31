# CR-02 — `voice-agent-session.ts` god file: substantially decomposed

- **Status:** Partially fixed — 4 modules extracted, −25%; one staged step deferred
- **Severity:** Medium
- **Area:** core architecture / maintainability / change risk

## Problem / Evidence

`VoiceAgentSession` was 1688 lines fusing several independently-testable
responsibilities (text segmentation, playout clocking, packet construction, init
ordering) into the orchestrator alongside its core turn-taking job.

## Root cause

Incremental hardening features were layered into one orchestrator class without
extracting focused modules.

## What landed (staged, characterization-test-first)

Each stage kept the existing 105-test characterization suite green before
committing; the suite is the safety net.

1. `voice-text.ts` — pure sentence/voice-text segmentation helpers. (commit 04ce98c)
2. `tts-playout-clock.ts` — the `TtsPlayoutClock` state machine (active set +
   playout-end estimates + release timers + real-transport override). No bus
   coupling, so behavior-preserving. (commit 04ce98c)
3. `packet-factories.ts` — typed constructors for every packet the session
   pushes; removed all 23 `as <Packet>` casts + 17 inline metric literals +
   typed the 3 `unknown` bus handlers (closes **CR-05**). (commit 1b026c0)
4. `init-stage-order.ts` — pure plugin→stage mapping + ordering. (commit d3bb3d0)
5. Focused unit tests for the pure extractions (`voice-text.test.ts`,
   `tts-playout-clock.test.ts`, +20 tests). (commit d3bb3d0)

**Session 1688 → 1273 lines (−25%). Voice suite 105 → 125 green.**

## Acceptance criteria

- [ ] `voice-agent-session.ts` reduced below 1000 lines. *(1273; see deferral)*
- [x] Extracted modules have focused tests and preserve existing behavior.
- [x] No regressions in `@asyncdot/voice` tests (125 green).

## Deferred (deliberately): interruption-controller extraction

The remaining ~1273 lines are cohesive orchestration — bus-handler wiring that
delegates to the modules above. The one cluster that would take the file under
1000 is the **primary-speaker barge-in gate state machine** (`pendingInterruption`
+ `handleVadSpeech*` + commit/suppress). That logic is **safety-critical for
conversation quality** and couples bus + gate + playout + latency-filler. This
issue's original note already called for "characterization test expansion" before
touching it.

Decision: not extracting it under a line-count target in this pass — the risk to
working barge-in behavior outweighs hitting the `<1000` proxy metric. The newly
added focused tests for the pure modules begin building the characterization net
a future `barge-in-controller.ts` extraction will need. That extraction is the
explicit next step, gated on expanding the gate/barge-in test battery first.

## Definition of done

Session orchestration split into focused modules with equivalent behavior and
lower change-risk surface — achieved for text/playout/packets/init-ordering. The
barge-in state machine remains in the orchestrator pending dedicated test
expansion (documented above, not silently capped).
