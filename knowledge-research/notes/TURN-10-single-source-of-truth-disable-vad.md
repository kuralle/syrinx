---
id: TURN-10
title: Single source of truth — disable redundant VAD when a turn model owns boundaries
domain: TURN
tags: [single-source-of-truth, redundant-vad, desync, flux, realtime-mode]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/turns/user_turn_strategies.py:81, pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:51, pipecat/src/pipecat/turns/user_stop/speech_timeout_user_turn_stop_strategy.py:62]
---

**Claim (one line):** Two detectors for one boundary desynchronize; whatever owns end-of-turn must be the *only* thing that fires it — so redundant downstream VAD/turn logic is disabled, not "kept as backup."

**Detail.** Deepgram is explicit: "When integrating Flux into LiveKit, Pipecat, or Vapi, **downstream VAD and turn logic should be disabled. Redundant detection introduces desynchronization, leading to premature responses or mid-utterance replies. Flux should be the single source of truth** for conversational boundaries" (`deepgram-ebook` ~557-561); Flux "emit[s] deterministic turn events, enabling the orchestration layer to react… without polling or redundant VAD" (~552). The clones encode the same principle structurally. Cartesia Ink-2-turns declares `supports_ttfs → False` — "TTFS doesn't apply: the server defines turn boundaries directly" (`turns/stt.py:176-179`) — and there is no `is_final` flag or `finalize` command because the server owns the turn (`stt.py:65`). Pipecat's `ExternalUserTurnStrategies` exists precisely for this: when an external processor (the STT/turn server) owns boundaries, the aggregator **does not push `UserStartedSpeakingFrame`/`UserStoppedSpeakingFrame` and does not generate interruptions** (`user_turn_strategies.py:81-100`). Conversely, when *local* turn detection is the intended driver (realtime LLM consuming audio), Pipecat flips `wait_for_transcript=False` so transcripts leave the critical path (`turn_analyzer_user_turn_stop_strategy.py:51-69`, `speech_timeout_user_turn_stop_strategy.py:56-70`) — one owner, cleanly chosen.

**Prior-art divergence.** Deepgram states the rule as prose; Pipecat enforces it with a *strategy container* (`ExternalUserTurnStrategies` vs default VAD+TurnAnalyzer) so you can't accidentally run both. LiveKit's design avoids the conflict differently — its EOU model *modulates* the VAD-driven delay rather than competing with it [[TURN-06-livekit-eou-internals]], so VAD and the model are by construction one pipeline, not two voters.

**Implication for Syrinx.** Decide the single owner of each boundary (start, stop) up front. If a provider model (Flux/Ink-2) owns it, hard-disable our VAD endpointing — don't leave it running "for safety," it will cause premature/mid-utterance replies. If we own it locally, take transcripts off the trigger path. Never let two systems vote on the same edge.

Links: [[TURN-04-flux-event-model]] [[TURN-06-livekit-eou-internals]] [[TURN-05-smartturn-internals]] [[wiki/barge-map]] [[wiki/turn-map]]
