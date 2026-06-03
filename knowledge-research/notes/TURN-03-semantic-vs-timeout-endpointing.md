---
id: TURN-03
title: Semantic/contextual endpointing vs fixed silence timeout
domain: TURN
tags: [endpointing, eot, semantic, silence-timeout]
sources: [vapi-pipeline-2, deepgram-ebook, together-talk]
code_refs: [pipecat/src/pipecat/audio/turn/smart_turn/base_smart_turn.py:121, agents/livekit-agents/livekit/agents/voice/audio_recognition.py:1131]
---

**Claim (one line):** A pause is not an end of turn; the central problem of endpointing is separating "thinking pause" from "done speaking," which a fixed silence timer cannot do and an ML/semantic signal can.

**Detail.** Together-AI calls turn detection "still somewhat unsolved… a pause ≠ end of turn, worst outcome = agent talks over the user" (`together-talk`). Vapi: a simple timeout is "robotic — too early cuts people off, too late = dead air"; switching from a fixed timeout to context-aware endpointing **reduced premature interruptions by 73%** (`vapi-pipeline-2` Problem #4). Two clone mechanisms embody the contrast: (1) **silence-timeout fallback** — Pipecat SmartTurn ends the turn purely on accumulated silence when `_silence_ms >= stop_secs*1000` (default 3s) regardless of content (`base_smart_turn.py:121-137`); (2) **semantic prediction** — both Pipecat SmartTurn and LiveKit EOU run an ML model that predicts completion from the *speech/transcript itself*, not just silence ([[TURN-05-smartturn-internals]], [[TURN-06-livekit-eou-internals]]). LiveKit fuses the two: the EOU model doesn't fire the turn directly — if `eou_probability < unlikely_threshold` it *extends the silence wait* from `min_delay` (0.5s) to `max_delay` (3.0s) (`audio_recognition.py:1131-1135`), so semantics tune the timer rather than replacing it.

**Prior-art divergence.** Vapi exposes endpointing as a *selector* over rule-based / ML / external / regex methods [[TURN-07-rule-ml-regex-selection]]. Deepgram folds turn detection into the STT model itself (Flux) so "semantic" and "transcript" are one model [[TURN-04-flux-event-model]]. Pipecat and LiveKit keep VAD and a separable turn model, but wire them oppositely: Pipecat gates the *turn-stop strategy* on the model verdict; LiveKit lets the model *modulate the endpointing delay*.

**Implication for Syrinx.** Fixed-silence endpointing is the floor, not the design. The highest-leverage, lowest-risk upgrade is LiveKit's pattern: keep a silence timer but let a semantic signal shrink it when the utterance "sounds finished" and stretch it when it doesn't. Pure-ML hard cutoffs risk truncation on model error; always keep a silence safety net (Pipecat does, `base_smart_turn.py:132`).

Links: [[TURN-04-flux-event-model]] [[TURN-05-smartturn-internals]] [[TURN-06-livekit-eou-internals]] [[TURN-07-rule-ml-regex-selection]] [[TURN-08-thresholds-speed-accuracy]] [[wiki/turn-map]]
