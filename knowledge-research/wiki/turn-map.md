# TURN — Turn-taking & Endpointing (Map of Content)

## Core problem
Deciding *when the user has finished speaking* is the hinge of conversational latency and naturalness. A pause is not an end of turn: stop too early and you talk over the user (the worst failure); stop too late and you leave dead air. The whole domain is the search for a signal better than a fixed silence timer — and the discipline to let exactly **one** signal own each boundary.

## Narrative
Start at detection. Raw energy thresholds flap on noise, so production VAD is a **4-state machine with hysteresis** [[TURN-01-vad-state-machine-hysteresis]] — QUIET→STARTING→SPEAKING→STOPPING, with asymmetric enter/exit (Pipecat: time-axis `start_secs`/`stop_secs`; LiveKit: confidence-axis dual thresholds). Because one speaker/room is not another, the threshold itself moves: Vapi tracks an **85th-percentile rolling baseline**, LiveKit-JS learns pause delays via EMA [[TURN-02-dynamic-baseline-percentile]].

But VAD only sees *silence*, and silence ≠ done. The central upgrade is **semantic/contextual endpointing vs the fixed timeout** [[TURN-03-semantic-vs-timeout-endpointing]] (Vapi: −73% premature interruptions). Three schools implement it:
- **STT-owns-the-turn**: Deepgram **Flux**'s event model [[TURN-04-flux-event-model]] (StartOfTurn / EagerEndOfTurn / TurnResumed / EndOfTurn), mirrored by Cartesia Ink-2-turns in the clones.
- **Separate audio-only model**: Pipecat **SmartTurn** [[TURN-05-smartturn-internals]] — Whisper-feature ONNX over the speech segment, 0.5 cut, 3s silence net.
- **Separate text-only model**: LiveKit **EOU** [[TURN-06-livekit-eou-internals]] — transcript→ONNX→probability, *modulating* the endpointing delay via per-language `unlikely_threshold`.

These aren't mutually exclusive: endpointing is a **selectable strategy chain** — rule/ML/external/regex/LLM-gated [[TURN-07-rule-ml-regex-selection]]. Every choice is a **threshold trade-off** [[TURN-08-thresholds-speed-accuracy]] (VAD 200/800ms, endpointing 0.5/3.0s, SmartTurn 0.5 + 3s net), and they couple across stages (Pipecat's STT-p99 safety net; text-models sitting behind STT-final). The biggest latency win is **eager-EOT speculative reasoning with cancel-on-resume** [[TURN-09-eager-eot-speculative-cancel]] (Vapi "greedy inference" / Flux eager_end→resume). And the rule that ties it together: **single source of truth — disable redundant VAD** when a turn model owns boundaries [[TURN-10-single-source-of-truth-disable-vad]], or two voters desync into premature/mid-utterance replies.

A critical distinction sits at the overlap of turn-taking and barge-in: **backchannels vs interruptions** [[TURN-11-backchannels-vs-interruptions]]. Overlapping speech is not always barge-in — brief affirmations ("mm-hmm") are conversational continuers that the system must suppress, not react to. LiveKit classifies them with an adaptive ML detector (ONNX, threshold 0.5), suppresses them during `backchannel_boundary` cooldowns (1.0s at turn start/end), and counts them separately from true interruptions in its telemetry.

## Canonical implementations
- **Pipecat**
  - VAD state machine + hysteresis: `pipecat/src/pipecat/audio/vad/vad_analyzer.py` (states `:30`, transitions `:206-243`, defaults `:24-27`); Silero ONNX `audio/vad/silero.py` (512 samples@16kHz `:190`).
  - SmartTurn ML EOT: `audio/turn/smart_turn/base_smart_turn.py` (silence net `:121-137`, segment build `:185-214`); v3 ONNX `local_smart_turn_v3.py` (log-mel `:163`, 8s `:160`, 0.5 cut `:174`); v2 PyTorch `local_smart_turn_v2.py:72`.
  - Turn strategy chain: `turns/user_turn_strategies.py` (defaults `:27-51`, External `:81`, LLM-gated `:104`); stop strategies `turns/user_stop/` (`speech_timeout_…:48`, `turn_analyzer_…:200`, `llm_turn_completion_…:18`); VAD start `turns/user_start/vad_user_turn_start_strategy.py`.
  - Provider turn protocol (Flux-style): `services/cartesia/turns/stt.py` (event loop `:60-63`, handlers `:162-166`, `supports_ttfs→False` `:176-179`).
- **LiveKit Python** (`agents/`)
  - EOU model: `livekit-plugins/livekit-plugins-turn-detector/livekit/plugins/turn_detector/base.py` (inference `:151-177`, per-lang threshold `:236-254`); `models.py` (revisions, `model_q8.onnx`).
  - Wiring: `livekit-agents/livekit/agents/voice/audio_recognition.py` (`_bounce_eou_task` `:1106`, threshold→delay `:1131-1135`); delays in `voice/agent_session.py:338-342`, `voice/agent.py:654`.
  - Silero VAD: `livekit-plugins/livekit-plugins-silero/livekit/plugins/silero/vad.py` (dual thresholds `:67`/`:110`, min_silence `:64`).
- **LiveKit JS** (`agents-js/`)
  - EOU model: `plugins/livekit/src/turn_detector/base.ts` (inference `:90-116`, threshold `:206-227`).
  - Endpointing: `agents/src/voice/turn_config/endpointing.ts` (`DynamicEndpointing` EMA `:90-249`, defaults `min500/max3000/alpha0.9` `:37`).
  - Backchannel classifier: `agents/src/inference/interruption_detector.ts` (ONNX model, threshold=0.5, min_frames=2, 0.5s prefix).
- **Deepgram** (source only): Flux event model + "single source of truth, disable downstream VAD" — `_sources/pdf/deepgram-voice-agent.parsed.md` ~530-561, params ~1986-1994.
- **Vapi** (source only): VAD 4-state machine + percentile baseline, endpointing selector, greedy inference — `_sources/blogs/vapi-pipeline-part-2.md`.

## Open questions / gaps
- **No clone exposes Vapi's 85th-percentile VAD energy baseline** — only the EMA pause-delay analog (LiveKit-JS). Worth a spike: is percentile gain-control measurably better than EMA on telephony?
- **Audio-only (SmartTurn) vs text-only (LiveKit EOU)** accuracy/latency is untested here. SmartTurn avoids the STT-final dependency but loses lexical cues; no head-to-head numbers in sources.
- **Eager-EOT divergence rate** ("speculative rarely diverges") is asserted by Deepgram, unquantified — needs measurement before we bet latency on it.
- **STT-p99 coupling** (Pipecat's safety net) assumes a benchmarked provider p99; we have no number for our STT yet. (unverified for Syrinx's stack)
- Deepgram Flux state diagram (Figure 2.1) labels are OCR-garbled in the parse; event *names* are clear but exact transition guards are not fully legible.
