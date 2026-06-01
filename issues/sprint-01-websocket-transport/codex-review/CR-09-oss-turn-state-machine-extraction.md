# CR-09 — Deferred barge-in state machine extraction remains a structural risk vs OSS patterns

- **Status:** **Architecture complete (Stages 0–3 shipped)** — Stage 4 features deferred by decision (additive roadmap)
- **Severity:** medium
- **Area:** session architecture / interruption correctness

> **Shipped:** `612f2a6` `3cb542f` `d669c1b` `bdce858`. The barge-in logic is now an
> explicit, position-aware state machine (`packages/voice/src/turn-arbiter.ts`,
> discriminated-union state, narrow injected deps), extracted from the session
> (1688 → **998** lines). Behavior-identical (the byte-frozen barge-in test suite is the
> proof); voice suite 125 → **142** green. **Stage 4** (resume / backchannel / min-words /
> semantic-endpoint + the composable-policy framework) is **not built** — each embeds a
> product decision or integration and would be speculative today; tracked as additive
> roadmap in the RFC §6. Resume is likely unnecessary given the gate design.

> **Design study:** see [`CR-09-RFC-explicit-turn-taking-state-machine.md`](./CR-09-RFC-explicit-turn-taking-state-machine.md).
> Root cause is not "big file" — it's an *implicit, distributed, position-blind*
> turn-taking state machine. The RFC is grounded in LiveKit (`SpeechHandle` + futures +
> `playback_position`), Pipecat (which **already extracted** turn-taking into a
> `UserTurnController` state-machine package on `main`), and full-duplex theory
> (Moshi/Smart-Turn/Full-Duplex-Bench). Implementation is staged and behavior-identical.

## Problem / Evidence

`VoiceAgentSession` still contains barge-in/interruption state handling inline with orchestration (`pendingInterruption`, VAD handlers, commit/suppress logic), keeping a high coupling hotspot in a still-large session file.

- `packages/voice/src/voice-agent-session.ts` (interruption state cluster)

This is exactly where future turn-taking regressions are likely as VE and transport behaviors evolve.

## Root cause

Round-2 decomposition intentionally deferred interruption-controller extraction due to safety risk and characterization coverage concerns.

## OSS cross-reference

Mature OSS stacks isolate interruption/playout semantics behind explicit state/event abstractions:

- Pipecat uses explicit interruption/system frames (`InterruptionFrame`) through pipeline processors and transports:
  - https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/frames/frames.py
  - https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/processors/frame_processor.py
- LiveKit separates speech handle lifecycle and playout completion semantics (`wait_for_playout`, playback-finished events):
  - https://github.com/livekit/agents/blob/main/livekit-agents/livekit/agents/voice/speech_handle.py
  - https://github.com/livekit/agents/blob/main/livekit-agents/livekit/agents/voice/io.py
  - https://docs.livekit.io/agents/logic/turns/tuning/

## Proposed solution

Extract a focused interruption controller module with explicit states/transitions and narrow input/output packet contracts, then move the current in-session gate logic behind it.

## Acceptance criteria

- [ ] Interruption state machine extracted from `voice-agent-session.ts`.
- [ ] Transition table covered with focused tests (false interruption, sustained interruption, suppressed non-primary, playout-complete paths).
- [ ] Session file reduced and left with orchestration wiring only.

## Test plan

- Characterization tests for existing interruption behavior first.
- Focused unit tests for the extracted controller state transitions.

## Definition of done

Interruption behavior is explicit, testable, and decoupled from the session orchestrator body.

## Why not fixed now

This is architectural surgery over a safety-critical path and requires a dedicated characterization expansion to avoid regressions in live turn-taking behavior.
