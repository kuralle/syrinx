# VE-03 / G24 — Latency-hiding filler token (dual-track)

- **Status:** Ready · **Priority:** P3 · **Phase:** E (engine)
- **Area:** perceived latency · **Findings:** papers (DDTSR, Moshi)
- **Depends on:** — · **Blocks:** —
- **Catalog:** G24

## Problem / Evidence

The dominant voice-to-voice latency line items are endpointing (~300 ms) and LLM
TTFB (~350 ms) (Kwindla budget). The literature hides LLM TTFB **without model
surgery**:
- **DDTSR** (`2602.23266`): a tiny model emits a leading discourse connective
  ("So…", "Well…") immediately while the large model reasons in the background —
  **19–51% perceived-latency reduction, no quality loss, no ASR/TTS changes**.
- **Moshi** (`2410.00037`): inner-monologue / text-ahead-of-audio alignment.

## Root cause (diagnose)

The pipeline waits for the LLM's first real token before any audio; the dead air
between endpoint and first audio is unfilled.

## Proposed solution (rfc)

Add an optional **dual-track filler**: the instant endpointing fires, synthesize a
short, context-appropriate discourse connective (from a tiny model or a curated
set selected by a fast classifier) and start playing it while the main LLM stream
spins up; splice the real response in seamlessly. Must be:
- Interruptible (the filler is cancellable like any TTS).
- Tasteful/configurable (off by default if it risks feeling robotic; A/B via metric).
- Measured: report perceived-latency (endpoint→first-audio) with/without.

## Acceptance criteria
- [x] Optional filler track starts audio at endpoint, before LLM TTFB.
- [x] Filler is interruptible and splices cleanly into the real response.
- [x] Perceived latency (endpoint→first-audio) drops measurably with it on.

## Test plan (TDD + smoke)
- **Unit:** on endpoint, filler audio is enqueued before the first LLM token;
  filler is cancelled if the user keeps talking; splice produces no overlap/gap.
- **Smoke (live):** interactive smoke A/B: report endpoint→first-audio P50/P95
  with filler on vs off; assert a reduction and no audible artifact.

## Definition of done
Optional, interruptible, tasteful filler that measurably cuts perceived latency,
A/B-proven in the live interactive smoke.

## Sources
DDTSR `2602.23266`; Moshi `2410.00037`; Kwindla latency budget.
