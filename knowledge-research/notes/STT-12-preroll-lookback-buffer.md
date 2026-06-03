---
id: STT-12
title: Pre-roll / look-back buffer — keep audio before VAD fires so the STT sees word onsets
domain: STT
tags: [preroll, lookback, buffer, vad, word-onset, clip-prevention]
sources: [vapi-pipeline-2]
code_refs: [pipecat/src/pipecat/services/google/gemini_live/llm.py:119, pipecat/src/pipecat/services/google/gemini_live/llm.py:123, pipecat/src/pipecat/services/google/gemini_live/llm.py:568, pipecat/src/pipecat/services/google/gemini_live/llm.py:1417]
---

**Claim (one line):** A pre-roll buffer captures the ~500 ms of audio *before* VAD triggers, so word onsets that land in the VAD's detection window are not silently dropped from the STT input — without it, the first syllables of every utterance are lost.

**Detail.** VAD has a detection lag: it confirms speech only after `start_secs` of sustained energy (e.g., Pipecat default 200 ms; [[TURN-01-vad-state-machine-hysteresis]]). Vapi adds an explicit **500 ms grace period** to avoid cutting off the start of words (vapi-pipeline-2, "Problem #2"). Pipecat's Gemini Live LLM service implements the equivalent: when server-VAD is disabled and turns are locally driven, `DEFAULT_USER_AUDIO_PREROLL_SECS = 0.5` (500 ms) at `gemini_live/llm.py:123`, and a `_user_audio_preroll_buffer` (`llm.py:568`) accumulates the rolling audio tail. The buffer size is either pinned by an explicit `user_audio_preroll_secs` override or dynamically sized from VAD's `start_secs + margin` via `SpeechControlParamsFrame` (`llm.py:1373-1382`). On `activity_start`, the buffer is **flushed and replayed** before live audio resumes: "activity_start must come first, immediately followed by the pre-roll audio" (test comment, `test_gemini_live_user_audio.py:121`). The buffer is then cleared to avoid replaying the same onset twice (`test_gemini_live_user_audio.py:125`). The Pipecat `AudioBufferProcessor` generalizes this with an `_audio_buffer_size_1s` field (`audio_buffer_processor.py:76`) computed from the sample rate as `self._sample_rate * 2` (`audio_buffer_processor.py:188`), enabling arbitrary pre-roll for recording/merging use cases.

**Prior-art divergence.** Pipecat's Gemini service does pre-roll explicitly for S2S models where the model receives raw audio; the standard cascade (STT service) relies on the STT provider to handle onset buffering internally. LiveKit does not expose a distinct pre-roll buffer — its VAD emits `START_OF_SPEECH` carrying `speech_duration` (`audio_recognition.py:1039-1040`), with `raw_accumulated_speech` read separately in the `INFERENCE_DONE` branch (`audio_recognition.py:1060`), but it does not replay buffered pre-onset audio through STT. Vapi's 500 ms grace period is the only source that quantifies the needed look-back from the VAD trigger point.

**Implication for Syrinx.** Buffer 500 ms of rolling audio before VAD trigger, replay it on voice-activity start, and ensure the STT socket receives the onset before the live stream continues. This directly reduces clipped-first-word errors (the source Deepgram failure-mode catalog does not name missing-preroll first-word clipping as a distinct mode — unverified).

Links: [[TURN-01-vad-state-machine-hysteresis]] [[STT-01-streaming-vs-batch]] [[STT-02-partial-final-lifecycle]] [[XPORT-05-frame-chunk-sizing]]
