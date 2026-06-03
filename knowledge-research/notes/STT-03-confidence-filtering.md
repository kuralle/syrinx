---
id: STT-03
title: Confidence-based filtering of partials (discard / keep / interrupt)
domain: STT
tags: [confidence, partials, filtering, barge-in, thresholds]
sources: [vapi-pipeline-2, diagrams, deepgram-ebook]
code_refs: [voice-ai/api/assistant-api/internal/transformer/deepgram/internal/stt_callback.go:60, pipecat/src/pipecat/services/deepgram/flux/base.py:664]
---

**Claim (one line):** Streaming partials carry a confidence score; the orchestrator gates them through tiered thresholds — discard low-confidence noise, keep mid-confidence for context, and only let high-confidence partials interrupt the speaking agent.

**Detail.** Vapi's partial-filter-chain has three outputs by confidence: **Discard** (conf < X), **Keep** (X < conf < Y), **Interrupt** (conf > Y) — "only higher-confidence transcripts can interrupt the AI while it's speaking" and "single-letter artifacts and common false positives filtered out" (vapi-pipeline-2:27-33, diagrams:21-25). Rapida implements exactly the discard gate: for each alternative it reads `listen.threshold`, and if `alternative.Confidence < v` it emits a `low_confidence` event and **`return nil`** — skipping all STT processing for that packet (`stt_callback.go:60-78`). Deepgram Flux applies the same idea at the *final* boundary: `_handle_end_of_turn` computes an average per-word confidence (`_calculate_average_confidence`, `flux/base.py:613-627`) and only pushes a `TranscriptionFrame` if `average_confidence > min_confidence`, else logs "below min_confidence threshold" and drops it (`flux/base.py:664-689`). The `should_interrupt` flag (`flux/base.py:593`) is the code-level "interrupt" tier — only a real turn-start triggers `broadcast_interruption()`.

**Prior-art divergence.** Vapi/Rapida gate **partials** by confidence (discard noise mid-stream); Pipecat Flux gates the **final** transcript by averaged word confidence. Pipecat's classic Deepgram path does *no* confidence gate — it forwards every non-empty interim/final (`deepgram/stt.py:695`), delegating filtering downstream. The "interrupt only on high confidence" tier is the barge-in safety valve — see [[BARGE-06-confidence-gated-interruption]].

**Implication for Syrinx.** A single discard threshold on partial confidence kills most spurious barge-ins cheaply; a separate, higher threshold should gate actual interruption of agent speech.

Links: [[STT-02-partial-final-lifecycle]] [[STT-06-wer-unrecoverable]] [[BARGE-06-confidence-gated-interruption]] [[TURN-04-flux-event-model]]
