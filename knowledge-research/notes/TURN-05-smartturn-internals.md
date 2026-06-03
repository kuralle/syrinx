---
id: TURN-05
title: Pipecat SmartTurn internals — audio-only Whisper-feature EOT model + silence net
domain: TURN
tags: [smart-turn, pipecat, ml-turn-detector, onnx, whisper-features]
sources: [modal-v2v]
code_refs: [pipecat/src/pipecat/audio/turn/smart_turn/base_smart_turn.py:99, pipecat/src/pipecat/audio/turn/smart_turn/local_smart_turn_v3.py:138, pipecat/src/pipecat/audio/turn/smart_turn/local_smart_turn_v3.py:160]
---

**Claim (one line):** Pipecat SmartTurn is an *audio-only* end-of-turn classifier: it runs a Whisper-style log-mel ONNX model over the speech segment and says complete/incomplete, with a hard silence timeout as the safety net.

**Detail.** Modal pairs **Silero VAD + SmartTurn** so bots "yield to interruptions but don't respond prematurely during brief mid-sentence pauses" (`modal-v2v`). Mechanism (`base_smart_turn.py`): `append_audio(buffer, is_speech)` buffers raw int16 PCM with monotonic timestamps; on speech it sets `_speech_triggered`, on silence it accumulates `_silence_ms` and **ends the turn on `_silence_ms >= stop_secs*1000`** (default `STOP_SECS=3`, `:27`, `:121-137`) — the fallback. Otherwise `analyze_end_of_turn()` runs the model on the segment: it slices `pre_speech_ms` (500ms, `:28`) before speech start, caps to `max_duration_secs=8` keeping the *end* (`:210-214`). V3 (`local_smart_turn_v3.py`) resamples to 16kHz (`:123`), pads/truncates to **8s** (`:160`), computes **Whisper log-mel features** (`:163`), runs ONNX `smart-turn-v3.2-cpu.onnx`, and thresholds the sigmoid: `prediction = 1 if probability > 0.5 else 0` (`:174`). Crucially the model sees **audio only — no transcript text**. V2 is the PyTorch `pipecat-ai/smart-turn-v2` variant (`local_smart_turn_v2.py:72`). It's CPU-cheap enough that Modal runs the whole bot on CPU (`modal-v2v`).

**Prior-art divergence.** This is the opposite design axis from LiveKit EOU [[TURN-06-livekit-eou-internals]], which is **text-only** (reads the transcript, not the audio). SmartTurn catches prosody/intonation cues a transcript loses; LiveKit EOU catches lexical/syntactic completion cues audio loses. Deepgram Flux unifies both inside the ASR [[TURN-04-flux-event-model]].

**Implication for Syrinx.** SmartTurn is attractive when we want turn detection independent of (and faster than) the STT final transcript — Modal even found VAD+turn-gated batch STT beats streaming STT on total v2v latency [[STT-08-segment-then-transcribe]]. The 0.5 sigmoid cut and 3s silence net are the two knobs; keep the silence net regardless of model confidence.

Links: [[TURN-06-livekit-eou-internals]] [[TURN-04-flux-event-model]] [[TURN-08-thresholds-speed-accuracy]] [[TURN-10-single-source-of-truth-disable-vad]] [[wiki/turn-map]]
