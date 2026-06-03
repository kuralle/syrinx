---
id: OBS-01
title: Event-level instrumentation — emit a timestamp for every turn boundary
domain: OBS
tags: [observability, events, instrumentation, turn-taking, session]
sources: [deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_activity.py:1492, pipecat/src/pipecat/observers/turn_tracking_observer.py, pipecat/src/pipecat/observers/user_bot_latency_observer.py:205]
---

**Claim (one line):** All speech-path observability is *derived* — the only raw signal you must capture is a timestamped event at every user/agent turn boundary; emit those and every latency metric falls out of arithmetic on the timestamps.

**Detail.** Deepgram frames this as the foundation: "Event-level instrumentation provides the most actionable insight. Tracking user stop, agent start, and audio completion events… reveals where conversational rhythm breaks down" (deepgram-ebook line 780–782); a production pipeline needs "Event instrumentation that emits timestamps and metadata for every user and agent turn" (line 1025–1026). The canonical Voice-Agent-API event vocabulary is `UserStartedSpeaking`, `UserStoppedSpeaking`, `AgentThinking`, `AgentStartedSpeaking`, `AgentAudioDone`, plus `FunctionCall*` (deepgram-ebook line 1035–1036, 1998–2006). Both clones implement this as an event/observer fan-in rather than a poll: LiveKit re-emits each provider metric on the session bus via `self._session.emit("metrics_collected", MetricsCollectedEvent(...))` (`agent_activity.py:1492`), wiring `metrics_collected` off every component (STT/LLM/TTS/VAD/interruption/realtime) at `agent_activity.py:679–739`. Pipecat instead runs passive **observers** that watch frame flow without mutating it — `TurnTrackingObserver` brackets each turn and `UserBotLatencyObserver` keys off `VADUserStoppedSpeakingFrame` → `BotStartedSpeakingFrame` (`user_bot_latency_observer.py:205,245,278`).

**Prior-art divergence.** LiveKit pushes a *typed metrics event* per stage (pull model — the app subscribes to `metrics_collected`); Pipecat pushes *frames through the pipeline* and lets `BaseObserver`s passively reconstruct timing (`observers/`). Deepgram exposes the events over the wire as Voice-Agent-API messages the customer's orchestrator times. Same idea, three delivery shapes: typed event bus vs. frame-stream observer vs. wire protocol message.

**Implication for Syrinx.** Define one canonical turn-boundary event set (UserStarted/Stopped, AgentThinking/Started/AudioDone, FunctionCall*) emitted with a monotonic timestamp + session-id at the orchestrator, and derive *all* latency/VAQI metrics downstream — don't instrument each metric independently.

Links: [[OBS-02-canonical-timing-metric]] [[OBS-04-per-stage-latency-metrics]] [[OBS-07-session-id-correlation]] [[OBS-08-otel-traces-spans]]
