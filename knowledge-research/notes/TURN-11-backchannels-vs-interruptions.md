---
id: TURN-11
title: Backchannels ("mm-hmm") vs interruptions — distinguish by duration, words, and ML classification
domain: TURN
tags: [backchannel, mm-hmm, interruption, adaptive-detector, overlap, boundary, classification]
sources: [deepgram-ebook, together-talk]
code_refs: [agents/livekit-agents/livekit/agents/voice/turn.py:108, agents/livekit-agents/livekit/agents/voice/turn.py:117, agents/livekit-agents/livekit/agents/voice/audio_recognition.py:1083, agents-js/agents/src/inference/interruption/interruption_stream.ts:348]
---

**Claim (one line):** Backchannels ("mm-hmm", "I see") overlap the agent's speech but are NOT interruptions — they are conversational continuers that the system must distinguish from true barge-in, suppressing only the backchannels so the agent isn't derailed by every listener murmur.

**Detail.** Human conversation includes frequent backchannel cues — brief affirmations that signal listening without claiming the floor. A voice agent that treats every overlapping speech as an interruption will be derailed by "mm-hmm" and constantly restart, creating unnatural "talks over user" failures. The problem has two parts: **detection** (is this overlapping speech a backchannel or an interruption?) and **suppression** (don't fire the barge-in sequence for backchannels).

LiveKit implements this via a three-part mechanism:

1. **Adaptive ML interruption detector** (`agents-js/agents/src/inference/interruption/interruption_detector.ts`): classifies overlapping speech as interruption vs backchannel. The JS client runs no local model — it POSTs audio to a remote inference-gateway endpoint (`http_transport.ts:49-67` appends `threshold`/`min_frames` to a predict URL and parses `is_bargein` from the response; `REMOTE_INFERENCE_TIMEOUT_IN_S=0.7`). Defaults (`agents-js/agents/src/inference/interruption/defaults.ts:7-10`): `threshold=0.5` (probability below which the overlap is classified as backchannel), `min_frames=2` at 25 ms each (50 ms minimum), and a 0.5 s audio prefix for inference context.

2. **Backchannel boundary cooldown** (`turn.py:108-124`): a `(start_cooldown, end_cooldown)` tuple that suppresses backchannel-classified events near the boundaries of each agent turn. Default is `(1.0, 1.0)` seconds — overlapping speech within 1 s of agent-speech start or 1 s of agent-speech end is treated as backchannel if the ML classifier agrees. The docstring: "seconds near the start/end of each agent turn during which overlapping speech classified as a backchannel by the adaptive detector is suppressed (events flagged as interruptions still pass through)." (`turn.py:110-113`).

3. **Selective suppression** in `AudioRecognition._on_overlap_speech_event` (`audio_recognition.py:1083`): when `backchannel_boundary_active` is True AND `ev.is_interruption` is False, the event is logged and dropped: "ignoring backchannel event during backchannel boundary cooldown, falling back to vad." This means true interruptions still fire even during the boundary window.

LiveKit also counts backchannels separately from interruptions in its telemetry: `InterruptionMetrics.num_backchannels` (`metrics/base.py:177`) is "incrementally counted" and distinguished from `num_interruptions` (`:175`), enabling separate dashboards for "false barge-in from backchannels" vs "true user interruptions."

The Together talk notes S2S models have a **native advantage** in backchannel handling: "full-duplex (produce audio while receiving → backchannel 'I see'/'aha')" (together-talk), because the model can emit backchannels while still listening — a capability cascading pipelines must simulate with explicit classification.

**Prior-art divergence.** LiveKit is the only clone with an explicit backchannel ML classifier + boundary cooldown. Deepgram describes backchannel *behavior* (ebook ~446: "subtle backchannel cues, brief affirmations") but doesn't expose a dedicated backchannel-detection API. Pipecat has no backchannel distinction in its interruption path. Cloudflare's client-side barge-in (`use-sfu-voice.ts`) has no backchannel classifier.

**Implication for Syrinx.** Implement a lightweight overlap classifier (ONNX or heuristic: duration < 0.5 s + 1–2 short words → backchannel candidate). Suppress backchannels during agent-speech boundaries; let true interruptions through the boundary even during cooldown. Track backchannel suppression as a distinct metric — it's the difference between "agent is responsive" and "agent constantly restarts."

Links: [[BARGE-06-confidence-gated-interruption]] [[BARGE-01-full-duplex-requirement]] [[BARGE-02-interruption-sequence]] [[BARGE-07-echo-auto-mute]] [[TURN-06-livekit-eou-internals]]
