---
id: OBS-02
title: The canonical timing metric — UserStoppedSpeaking → AgentStartedSpeaking
domain: OBS
tags: [observability, latency, e2e, turn-taking, slo]
sources: [deepgram-ebook, vapi-latency, modal-v2v, together-talk]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_activity.py:2769, pipecat/src/pipecat/observers/user_bot_latency_observer.py:292, agents/livekit-agents/livekit/agents/telemetry/otel_metrics.py:23]
---

**Claim (one line):** The single first-class conversational latency metric is the wall-clock from the user falling silent to the agent producing its first audio — `AgentStartedSpeaking − UserStoppedSpeaking` — and it is computed as a literal subtraction of two boundary timestamps, not a sum of stage estimates.

**Detail.** Every primary source names this same interval. Deepgram's VAQI "Latency (L)" is "elapsed time from UserStoppedSpeaking to AgentStartedSpeaking" (deepgram-ebook line 970–971); Vapi's "core metric… latency-to-response = duration between user's end of statement and agent's start of statement" (vapi-latency line 5); Modal's "figure of merit = duration from user stops speaking to first hearing the bot" with "natural… as short as 100ms," apps targeting ~1s (modal-v2v line 25–26); Retell hits ~800ms in production (deepgram-ebook line 979). LiveKit computes it directly: `e2e_latency = started_speaking_at - user_metrics["stopped_speaking_at"]` (`agent_activity.py:2769`), where `started_speaking_at` is when the agent's first audio frame is forwarded (`_on_first_frame`, `agent_activity.py:2314,2371`) and `stopped_speaking_at` comes from the user-turn metrics; it's then exported as the `lk.agents.turn.e2e_latency` histogram (`otel_metrics.py:23`). Pipecat's `UserBotLatencyObserver._handle_bot_started_speaking` does the mirror: `latency = time.time() - self._user_stopped_time` at `BotStartedSpeakingFrame` (`user_bot_latency_observer.py:292–295`).

**Prior-art divergence.** A subtlety: *which* "user stopped" instant? Pipecat anchors to **actual silence** = `VADUserStoppedSpeakingFrame.timestamp − stop_secs`, deliberately subtracting the VAD hangover so endpointing delay is *inside* the measured latency, not excluded (`user_bot_latency_observer.py:249`). LiveKit similarly uses `last_speaking_time` (the raw VAD stop) as the anchor (`audio_recognition.py:1193`). Both refuse to start the clock at the *turn-decision* instant — that would hide endpointing cost, the largest tunable lever.

**Implication for Syrinx.** Make UserStopped→AgentStarted the headline SLO metric, and anchor "UserStopped" to *raw VAD silence onset minus hangover*, not the endpointing decision — otherwise tuning turn thresholds will look free when it isn't.

Links: [[OBS-01-event-instrumentation-turn-boundaries]] [[OBS-03-vaqi-i-m-l]] [[OBS-05-eou-vs-transcription-delay]] [[OBS-06-slos-percentiles-tail]] [[TURN-01-vad-state-machine-hysteresis]] [[LAT-04-turn-budget-split]]
