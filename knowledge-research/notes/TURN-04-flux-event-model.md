---
id: TURN-04
title: Flux event-driven turn model — StartOfTurn / EagerEndOfTurn / TurnResumed / EndOfTurn
domain: TURN
tags: [flux, deepgram, eager-eot, events, eot-threshold]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/services/cartesia/turns/stt.py:60, pipecat/src/pipecat/services/cartesia/turns/stt.py:162]
---

**Claim (one line):** Deepgram Flux collapses ASR+VAD into one conversational model that emits a deterministic 4-event turn lifecycle, so orchestration reacts to events instead of polling timers.

**Detail.** Flux emits four events (`deepgram-ebook` ~line 542-547, 1989-1994):
- **StartOfTurn** — user begins speaking → cancel playback.
- **EagerEndOfTurn** — *medium*-confidence end → begin **speculative reasoning** (LLM may start early).
- **TurnResumed** — user continued after an eager end → **cancel the speculative work**.
- **EndOfTurn** — *high*-confidence completion → finalize the response.

Tuning is two thresholds plus a timeout: `eager_eot_threshold`, `eot_threshold`, `eot_timeout_ms` (`deepgram-ebook` ~1986, 1994), which trade speed vs stability; "Flux is designed to keep transcripts highly consistent between eager and final boundaries… speculative reasoning rarely diverges from the final text" (~549). The clone mirror is Cartesia's Ink-2 v2 turn protocol: the server drives `connected → turn.start → turn.update* → (turn.eager_end → turn.resume?)* → turn.end` (`stt.py:60-63`), exposing the identical event set as handlers `on_turn_start / on_turn_update / on_turn_eager_end / on_turn_resume / on_turn_end` (`stt.py:162-166`). Transcripts are **cumulative per turn**, "no is_final flag and no finalize command" (`stt.py:65`) — the server owns turn boundaries.

**Prior-art divergence.** This is the "STT-is-the-turn-detector" school: Deepgram Flux and Cartesia Ink-2-turns put end-of-turn *inside* the streaming ASR. Contrast Pipecat/LiveKit, which keep a separate VAD + turn model alongside an independent STT [[TURN-05-smartturn-internals]] [[TURN-06-livekit-eou-internals]]. The eager/resume pair is the wire-level form of predict-and-scrap [[TURN-09-eager-eot-speculative-cancel]].

**Implication for Syrinx.** If we adopt Flux or Ink-2-turns, the turn machine is *theirs* — we must NOT also run our own VAD endpointing or we desync [[TURN-10-single-source-of-truth-disable-vad]]. The eager_end/resume events are the integration hook for speculative LLM start + cancel.

Links: [[TURN-09-eager-eot-speculative-cancel]] [[TURN-10-single-source-of-truth-disable-vad]] [[TURN-03-semantic-vs-timeout-endpointing]] [[wiki/turn-map]]
