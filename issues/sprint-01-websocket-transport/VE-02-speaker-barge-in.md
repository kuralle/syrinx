# VE-02 / G23 — Speaker-attribution barge-in gate

- **Status:** Ready · **Priority:** P2 · **Phase:** E (engine)
- **Area:** barge-in · **Findings:** papers (FireRedChat); strengthens G1
- **Depends on:** — · **Blocks:** —
- **Catalog:** G23 (strengthens G1)

## Problem / Evidence

The false-barge-in gate (G1) is a **time threshold** (`minInterruptionMs`, default
280 ms): it suppresses very short blips but still commits on any sustained speech —
including a bystander, a TV, or the agent's own echo. The 2025–26 answer reframes
false barge-in as **speaker attribution**:
- **FireRedChat** (`2509.06502`): a streaming **personalized/primary-speaker VAD
  (pVAD)** that suppresses noise + non-primary speakers, cutting false barge-ins,
  as a pluggable controller in front of an existing cascade.

## Root cause (diagnose)

G1's gate has no notion of *who* is speaking; any sufficiently long energy commits
the interruption.

## Proposed solution (rfc)

Add a **primary-speaker gate** on the barge-in path:
- Lock onto the primary speaker (speaker embedding from the first user turn, or a
  pVAD conditioned on it) and gate `interrupt.detected` on primary-speaker
  presence, not raw VAD energy.
- Compose with G1's time gate: commit only when primary-speaker speech is sustained
  past `minInterruptionMs`. Background/bystander/echo speech does not commit; record
  `interrupt.suppressed_non_primary`.
- Keep it pluggable (a controller in front of the existing interruption logic), and
  degrade gracefully where no speaker model is available (fall back to G1).

## Acceptance criteria
- [ ] Barge-in gated on primary-speaker presence, composed with the G1 time gate.
- [ ] Bystander/TV/echo speech is suppressed (`interrupt.suppressed_non_primary`).
- [ ] Graceful fallback to G1 when speaker attribution is unavailable.

## Test plan (TDD + smoke)
- **Unit:** mixed audio (primary + bystander) → only primary commits; echo of the
  agent's own TTS does not commit; absent speaker model → G1 behavior preserved.
- **Smoke (live):** live smoke with injected background speech during assistant
  playout; assert the assistant is not falsely interrupted; capture metrics.

## Definition of done
False barge-ins from non-primary speakers are suppressed via speaker attribution,
composed with G1, with a graceful fallback, proven in unit + live smoke.

## Sources
FireRedChat `2509.06502` (personalized/primary-speaker VAD); catalog G1.
