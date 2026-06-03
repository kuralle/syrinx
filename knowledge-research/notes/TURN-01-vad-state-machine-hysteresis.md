---
id: TURN-01
title: VAD 4-state machine with start/stop hysteresis
domain: TURN
tags: [vad, state-machine, hysteresis, debounce]
sources: [vapi-pipeline-2, diagrams, modal-v2v]
code_refs: [pipecat/src/pipecat/audio/vad/vad_analyzer.py:30, pipecat/src/pipecat/audio/vad/vad_analyzer.py:206, agents/livekit-plugins/livekit-plugins-silero/livekit/plugins/silero/vad.py:63]
---

**Claim (one line):** Production VAD is not a threshold but a 4-state machine (QUIET → STARTING → SPEAKING → STOPPING) with *asymmetric* enter/exit timing so noise can't flap the speech flag.

**Detail.** Vapi describes exactly four states with "different thresholds for starting vs stopping (hysteresis) to prevent nervous switching" — ~200ms sustained detection to confirm start, ~800ms sustained silence to confirm stop (`vapi-pipeline-2` Problem #1; `diagrams` vapi-vad-diagram). Pipecat implements this verbatim: `VADState{QUIET, STARTING, SPEAKING, STOPPING}` (`vad_analyzer.py:30`) and a per-frame transition table (`vad_analyzer.py:206-243`). A frame counts as "speaking" only when `confidence >= params.confidence AND volume >= params.min_volume` (`:206`); the machine then needs `start_secs` worth of consecutive speaking frames to reach SPEAKING (`:229`) and `stop_secs` of consecutive silence to return to QUIET (`:236`). Pipecat's *defaults* are symmetric and short — `VAD_CONFIDENCE=0.7, VAD_START_SECS=0.2, VAD_STOP_SECS=0.2, VAD_MIN_VOLUME=0.6` (`:24-27`) — so the 800ms-stop hysteresis in the blog is a *tuning choice*, not the library default. LiveKit's Silero VAD bakes hysteresis into the *confidence axis* instead: `activation_threshold=0.5` to enter speech, `deactivation_threshold=max(activation-0.15, 0.01)` to leave it (`vad.py:67`, docstring `:110`), with `min_silence_duration=0.55s` and `min_speech_duration=0.05s` (`:64-63`).

**Prior-art divergence.** Pipecat = hysteresis on the **time axis** (asymmetric `start_secs`/`stop_secs` frame counts, single confidence threshold). LiveKit = hysteresis on the **confidence axis** (dual activation/deactivation thresholds) *plus* min-silence timing. Vapi claims both an asymmetric 200/800ms time machine and (separately) a dynamic confidence baseline [[TURN-02-dynamic-baseline-percentile]]. Volume gate (`min_volume`) is Pipecat-specific belt-and-suspenders on top of the ML confidence.

**Implication for Syrinx.** If we run Silero, pick one hysteresis axis deliberately. A single confidence cutoff with symmetric 200ms timers (Pipecat defaults) will flap on noisy phone audio; either raise `stop_secs` (~0.8s) or adopt dual thresholds like LiveKit. Note: lengthening `stop_secs` directly inflates end-of-turn latency — see [[TURN-08-thresholds-speed-accuracy]].

Links: [[TURN-02-dynamic-baseline-percentile]] [[TURN-03-semantic-vs-timeout-endpointing]] [[TURN-08-thresholds-speed-accuracy]] [[wiki/turn-map]]
