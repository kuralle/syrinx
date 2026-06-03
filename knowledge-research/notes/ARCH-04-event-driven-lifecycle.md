---
id: ARCH-04
title: Event-driven lifecycle — the conversational loop is overlapping, not sequential
domain: ARCH
tags: [events, lifecycle, state-machine, agent-state, coordination]
sources: [deepgram-ebook, vapi-pipeline-2, together-talk]
code_refs: [agents/livekit-agents/livekit/agents/voice/events.py:107, pipecat/src/pipecat/frames/frames.py:962]
---

**Claim (one line):** Voice orchestration is an **event-driven loop with overlapping stages and an explicit agent-state machine** (listening / thinking / speaking), driven by lifecycle events — not a strict turn-by-turn pipeline.

**Detail.** Deepgram's conversational loop is Listen→Understand→Reason→Respond→Speak, but "in production systems this loop does not operate as a strict, turn-by-turn pipeline. The stages overlap and run concurrently… begin reasoning before a user has finished speaking, or start speaking while the remainder of a response is still being generated" (`deepgram-voice-agent.parsed.md:143-147`). This requires "an event-driven, interrupt-aware architecture that treats timing and partial signals as first-class inputs" (`deepgram-voice-agent.parsed.md:163-166`). LiveKit encodes the state machine explicitly: `AgentState = Literal["initializing","idle","listening","thinking","speaking"]` and `UserState = Literal["speaking","listening","away"]` (`agents/.../voice/events.py:107-108`), emitted as `AgentStateChangedEvent`/`UserStateChangedEvent` plus `user_input_transcribed`, `conversation_item_added`, `speech_created` (`events.py:92-101,111-119`). Cloudflare's voice mixin sends the same states as JSON status messages — `{type:"status", status:"thinking"}` on turn start, `"speaking"` during TTS, `"listening"` after interrupt (`cloudflare-agents/packages/voice/src/voice.ts:587,607`). Pipecat carries them as SystemFrames: `UserStartedSpeakingFrame`/`BotStartedSpeakingFrame`/`BotStoppedSpeakingFrame` (`frames.py:962-1098`). Vapi: "coordinated through an event-driven architecture" (`vapi-pipeline-2.md:58`); the breakthrough was realizing stream coordination is a "conversation-understanding problem" where each stream must know what the others are doing (`vapi-pipeline-1.md:45`).

**Prior-art divergence.** LiveKit and Cloudflare both expose a literal 3-state agent FSM (listening/thinking/speaking) to clients; Pipecat exposes per-event frames and leaves state aggregation to observers (RTVI). Deepgram pushes the FSM entirely server-side in the managed runtime. All agree on overlap/concurrency as the defining property versus the rejected "Batch Processing Cascade" (see [[ARCH-05-batch-vs-streaming-vs-s2s]]).

**Implication for Syrinx.** Expose an explicit agent-state event stream (≥ listening/thinking/speaking) to the client and to our own observability — UI feedback and turn-taking logic both depend on it. Treat partial transcripts and VAD events as first-class triggers, not just data.

Links: [[ARCH-03-system-vs-data-frame-ordering]] [[ARCH-05-batch-vs-streaming-vs-s2s]] [[ARCH-06-three-parallel-streams]] [[OBS-01-event-instrumentation-turn-boundaries]] [[TURN-01-vad-state-machine-hysteresis]]
