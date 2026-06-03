---
id: ARCH-08
title: LiveKit AgentSession — the stateful container that wires STT→LLM→TTS via nodes
domain: ARCH
tags: [livekit, agentsession, agentactivity, nodes, stt-llm-tts]
sources: [together-talk, deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_session.py:401, agents/livekit-agents/livekit/agents/voice/agent.py:414]
---

**Claim (one line):** LiveKit splits orchestration into **`AgentSession`** (long-lived stateful container holding stt/vad/llm/tts + the room I/O) and **`AgentActivity`** (per-agent runtime), with STT→LLM→TTS expressed as overridable async-generator **node** methods on `Agent`.

**Detail.** `AgentSession.__init__` takes `stt/vad/llm/tts` and stores them as `self._stt/_vad/_llm/_tts` plus `_turn_detection` (`agents/.../agent_session.py:222-406`); `llm` is typed `llm.LLM | llm.RealtimeModel` so the same container drives both cascade and S2S (`agent_session.py:227`). The session creates an `AgentActivity(agent, self)` per active agent and swaps it on agent handoff via `_update_activity` (`agent_session.py:1325-1346`). The actual speech wiring lives in **node methods** on `Agent` (all overridable async generators):
- **`stt_node`** streams `rtc.AudioFrame`s in, yields `stt.SpeechEvent`s; auto-wraps a non-streaming STT with `StreamAdapter(stt, vad)` so VAD segments audio for batch STT (`agent.py:414-459` esp. 423-430).
- **`llm_node`** opens `llm.chat(chat_ctx, tools, tool_choice)` and yields `ChatChunk`s; asserts non-realtime (cascade only) (`agent.py:462-483`).
- **`tts_node`** streams text in, yields `rtc.AudioFrame`s; auto-wraps non-streaming TTS with a `StreamAdapter` + `SentenceTokenizer` for sentence boundarying (`agent.py:486-519` esp. 499-503).
- **`transcription_node`** forwards text for client display (`agent.py:521+`).

`AgentActivity` owns an `AudioRecognition` (`agent_activity.py:791`) wired with `RecognitionHooks` — `on_start_of_speech`, `on_interim_transcript`, `on_final_transcript`, `on_end_of_turn`, `on_preemptive_generation` (`audio_recognition.py:74-82`). `on_end_of_turn` is **deliberately synchronous** "to avoid it being cancelled by the AudioRecognition" and spawns the reply task itself (`agent_activity.py:1921-1923`). The reply runs through `_pipeline_reply_task` (`agent_activity.py:2467`).

**Prior-art divergence.** Deepgram catalogs this as the "LiveKit Audio Room Agent (Transport Topology)" — LiveKit owns the WebRTC room/SFU, agent participates as a peer, STT/TTS plug in as nodes (`deepgram-voice-agent.parsed.md:1659-1669`). The node-override design is LiveKit-specific: you customize a stage by subclassing one async generator, vs Pipecat where you insert a processor into the chain. The JS SDK (`agents-js/agents/src/voice/agent_session.ts`, `agent_activity.ts`, `audio_recognition.ts`) mirrors the Python structure 1:1 — same AgentSession/AgentActivity/AudioRecognition split.

**Implication for Syrinx.** The session-as-stateful-container + pluggable-node shape is a clean target: one long-running object holds conversation state and the swappable stt/llm/tts handles, while each stage is an async stream we can wrap (StreamAdapter pattern) to bridge streaming vs non-streaming providers. The sync end-of-turn hook is a deliberate guard against cancellation races — worth copying.

Links: [[ARCH-01-frame-pipeline-model]] [[ARCH-05-batch-vs-streaming-vs-s2s]] [[ARCH-06-three-parallel-streams]] [[ARCH-09-rapida-cloudflare-runtimes]] [[TURN-03-semantic-vs-timeout-endpointing]] [[STT-13-stream-adapter-pattern]]
