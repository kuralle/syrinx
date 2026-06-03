# VE-02 — Turn-taking & endpointing

**Type:** AFK · **Tier:** Tier-0 · **Status:** Backlog
**Master document:** [`../../PRODUCTION-CHECKLIST.md`](../../PRODUCTION-CHECKLIST.md) → **§3 Turn-Taking & Endpointing**

## What to build
Reliable detection of when the user starts and finishes a turn, feeding the final-transcript handoff from VE-01. One owner per boundary — no double-finalization.

## Acceptance criteria
- [ ] VAD as a hysteretic state machine (QUIET→STARTING→SPEAKING→STOPPING), not a single energy cutoff.
- [ ] One endpointing strategy selected (semantic/contextual EOT where available, else rule/timer), with rule/timer fallback.
- [ ] **Single source of truth per boundary:** when a provider owns EOT (e.g. Flux-style), downstream VAD/endpointing is disabled to prevent desync.
- [ ] Endpointing delay + STT-final latency + VAD stop time treated as one budget kept inside the v2v target (not each knob locally minimized).
- [ ] Eager-EOT exposed as a *signal* only (commit on final EOT) — wiring to speculative gen is VE-08.

## Demo / verify
Conversational turns end crisply: no cutting the user off mid-sentence, no long dead-air after they finish; measure UserStoppedSpeaking→AgentStartedSpeaking.

## Blocked by
VE-01.

## Key references
notes: TURN-01..10; wiki/turn-map.
