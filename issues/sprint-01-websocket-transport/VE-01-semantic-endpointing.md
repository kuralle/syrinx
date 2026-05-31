# VE-01 / G22 — Semantic endpointing fused off the STT encoder

- **Status:** In Review · **Priority:** P2 · **Phase:** E (engine)
- **Area:** turn-taking · **Findings:** papers (Phoenix-VAD, FastTurn, JAL-Turn)
- **Depends on:** — · **Blocks:** —
- **Catalog:** G22

## Problem / Evidence

End-of-turn currently relies on Silero VAD + Smart Turn (a **separate** ONNX model
in `voice-turn-pipecat`). The 2025–26 literature has converged on **semantic
endpointing fused with acoustics, run cheaply off the ASR encoder**:
- **JAL-Turn** (`2603.26515`): shares a **frozen ASR encoder** via cross-attention →
  turn prediction in parallel with ASR, **zero added latency/GPU**.
- **Phoenix-VAD** (`2509.20410`): streaming semantic endpointer over 320 ms chunks,
  plug-and-play.
- **FastTurn** (`2604.01897`): fuses streaming CTC + acoustics; robust to
  backchannels + noise (ships a backchannel/noise eval set).

Silence-timer/Smart-Turn-only endpointing causes both premature cutoffs and
trailing latency.

## Root cause (diagnose)

Smart Turn is a bolt-on model; it doesn't see the STT transcript stream, so it
can't use semantic completeness — only acoustic/turn cues.

## Proposed solution (rfc)

Add a **semantic-completeness signal** alongside Smart Turn:
- Consume the streaming STT partials (already on the bus) + a lightweight
  completeness head (or a small LLM/classifier) to score end-of-turn on semantics.
- Fuse with Smart Turn: release the turn when semantic completeness AND provider
  finalization agree; let a clear semantic completion shortcut a long silence timer,
  and a mid-thought pause defer despite silence.
- Prefer the JAL-Turn architecture direction (reuse the STT encoder/partials) to
  keep marginal latency ~0; document the exact approach + tradeoff in
  `implementation-notes.md`. Do not replace Smart Turn — augment it.

## Acceptance criteria
- [x] A semantic end-of-turn signal is computed from STT partials and fused with Smart Turn.
- [x] Premature-cutoff and trailing-latency cases improve on a labeled set (see tests).
- [x] No net latency regression on the interactive smoke (P50/P95).

## Test plan (TDD + smoke)
- **Unit:** on a labeled set of {complete utterance, mid-thought pause, backchannel},
  the fused decision yields earlier release on complete utterances and deferral on
  mid-thought pauses vs Smart-Turn-only (use a FastTurn-style backchannel/noise set).
- **Smoke (live):** interactive + live recorder smokes show no latency regression
  and fewer premature cuts on multi-clause utterances; capture metrics.

## Definition of done
Fused semantic+acoustic endpointing measurably reduces premature cuts without
latency regression, proven on a labeled set + live smoke.

## Sources
JAL-Turn `2603.26515`, Phoenix-VAD `2509.20410`, FastTurn `2604.01897`.
