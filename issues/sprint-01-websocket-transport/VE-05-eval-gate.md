# VE-05 / G26 — EVA-Bench / Full-Duplex-Bench CI gate

- **Status:** Ready · **Priority:** P3 · **Phase:** E (engine)
- **Area:** evaluation · **Findings:** papers (EVA-Bench, Full-Duplex-Bench-v2)
- **Depends on:** — (stronger once VE-01/02/03 land) · **Blocks:** —
- **Catalog:** G26

## Problem / Evidence

Transport and turn-taking changes can silently regress conversation quality, and
there is no automated, bot-to-bot regression gate. A mature 2025–26 eval stack now
exists:
- **EVA-Bench** (`2605.13841`): bot-to-bot audio conversations, EVA-A (task
  completion, faithfulness, audio fidelity) + EVA-X (progression, conciseness,
  **turn-taking timing**), with accent/noise perturbations.
- **Full-Duplex-Bench-v2** (`2510.07838`): overlap, mid-turn corrections,
  long-range entity tracking under two pacing conditions.

## Root cause (diagnose)

Smokes assert transport/audio invariants but not conversational/turn-taking
quality; nothing fails CI when turn-taking timing or noise robustness regresses.

## Proposed solution (rfc)

Build an **automated examiner harness** (EVA-X turn-taking-timing axis +
accent/noise perturbations as the first gate) that runs a scripted bot-to-bot
conversation through the engine and scores turn-taking timing + overlap handling.
Wire it as a CI gate (warn → then block) so a transport/turn-taking change cannot
regress these axes. Reuse the existing smoke harness + recorder + Whisper audit;
add the EVA-X scoring layer. Keep model-judge axes as diagnostics initially.

## Acceptance criteria
- [ ] Bot-to-bot examiner runs the engine and scores turn-taking timing + overlap.
- [ ] Accent/noise perturbation suite included.
- [ ] CI gate (warn first, then block) on turn-taking-timing / overlap regression.

## Test plan (TDD + smoke)
- **Unit:** the examiner scores a known-good vs known-bad transcript/timeline
  correctly (deterministic fixtures).
- **Smoke (live):** the examiner runs end-to-end over the live engine and produces
  EVA-X timing + overlap scores with a baseline artifact.

## Definition of done
An automated conversational-quality gate (turn-taking timing + overlap + noise)
runs in CI over the live engine with a recorded baseline.

## Sources
EVA-Bench `2605.13841`; Full-Duplex-Bench-v2 `2510.07838`.
