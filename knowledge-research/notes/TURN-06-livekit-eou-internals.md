---
id: TURN-06
title: LiveKit turn-detector internals — text-only EOU model modulating the endpointing delay
domain: TURN
tags: [livekit, eou, turn-detector, unlikely-threshold, onnx, endpointing-delay]
sources: []
code_refs: [agents/livekit-plugins/livekit-plugins-turn-detector/livekit/plugins/turn_detector/base.py:151, agents/livekit-plugins/livekit-plugins-turn-detector/livekit/plugins/turn_detector/base.py:236, agents/livekit-agents/livekit/agents/voice/audio_recognition.py:1131, agents-js/plugins/livekit/src/turn_detector/base.ts:90]
---

**Claim (one line):** LiveKit's turn detector is a *text-only* transformer (Qwen-tokenized chat context → ONNX → EOU probability) whose output doesn't fire the turn but *stretches or shrinks the silence wait* via a per-language `unlikely_threshold`.

**Detail.** Model `livekit/turn-detector`, ONNX `model_q8.onnx`, revisions `v1.2.2-en` / `v0.4.1-intl` (`models.py`). It takes the **last 6 turns / 128 tokens** of *transcript* (`base.py:25-26`, `:280`), formats with the chat template, strips the trailing `<|im_end|>` EOU token from the current utterance (`base.py:90-93`), runs ONNX, and reads `eou_probability` from the **last token's logit** (`base.py:169`). No audio is consumed — purely lexical. Thresholds are **per-language**, loaded from `languages.json` (`base.py:236-254`); a user override `unlikely_threshold` is "not recommended unless you're confident" (`base.py:207`). Wiring (`audio_recognition.py:1106-1135`): after VAD stop, `_bounce_eou_task` calls `predict_end_of_turn()`; **if `eou_probability < unlikely_threshold`, the endpointing delay is raised from `min_delay` to `max_delay`** (`:1135`) — defaults `min=0.5s`, `max=3.0s` (`agent_session.py:339,342`). So a low EOU score = "probably mid-thought" = wait longer; a high score = release at `min_delay`. JS mirrors this: `EOURunnerBase.run` returns `eouProbability` from the last logit (`base.ts:90-105`), `unlikelyThreshold(language)` reads `languages.json` (`base.ts:206-227`), and `DynamicEndpointing` consumes it [[TURN-02-dynamic-baseline-percentile]].

**Prior-art divergence.** Text-only ⇒ LiveKit **depends on the STT transcript** before it can score, adding the STT-final-transcript latency to every turn; SmartTurn (audio-only) does not [[TURN-05-smartturn-internals]]. LiveKit's "modulate the delay" wiring is softer than Pipecat's "gate the stop strategy on COMPLETE" — LiveKit always waits at least `min_delay`, never hard-cuts on the model.

**Implication for Syrinx.** If our turn model is text-only, it sits *behind* STT finalization on the critical path — co-locate STT and keep the model's job to *bias a timer*, not to be the sole trigger. The per-language threshold table matters: a single global threshold mis-serves non-English.

Links: [[TURN-05-smartturn-internals]] [[TURN-02-dynamic-baseline-percentile]] [[TURN-03-semantic-vs-timeout-endpointing]] [[TURN-08-thresholds-speed-accuracy]] [[wiki/turn-map]]
