---
id: BARGE-02
title: The under-100ms interruption sequence
domain: BARGE
tags: [latency, sequence, abort, flush]
sources: [vapi-pipeline-2, deepgram-ebook]
code_refs: [pipecat/src/pipecat/processors/frame_processor.py:632, agents/livekit-agents/livekit/agents/voice/agent_activity.py:1268]
---

**Claim (one line):** Detecting barge-in triggers a fixed ordered sequence — abort LLM → stop TTS → clear audio buffers → re-enter listening — that must complete in under 100ms.

**Detail.** Vapi states the budget directly: "Interruption (barge-in) sequence — must complete in under 100ms: (1) VAD detects speech start, emits events; (2) LLM request aborted; (3) TTS generation stops immediately; (4) audio buffers cleared to prevent glitchy playback; (5) system switches to listening mode" (vapi-pipeline-2 line 49-54). Pipecat implements this as a single `InterruptionFrame` that fans out: `process_frame` dispatches it to `_start_interruption()` (`frame_processor.py:632-636`), which cancels and re-creates each processor's queue-draining task (`frame_processor.py:842-862`); the TTS service handles it via `_handle_interruption` → `reset_active_audio_context()` (`tts_service.py:902-923`); the output transport's `handle_interruptions` cancels the audio task and clears the buffer (`base_output.py:538-561`). LiveKit's `AgentActivity.interrupt()` does the same fan-out in one call: cancel preemptive generation, interrupt the current speech, interrupt every queued speech, and interrupt the realtime session (`agent_activity.py:1268-1303`).

**Prior-art divergence.** Vapi gives the explicit <100ms budget; LiveKit/Pipecat do not name a number but achieve the same ordering through a single broadcast frame/call so the steps fire effectively simultaneously rather than serially. Deepgram splits the same sequence into two enforcement levels — see [[BARGE-03-media-vs-logic-levels]].

**Implication for Syrinx.** Model interruption as one event broadcast to every stage, not a chain of awaits — serial awaits blow the 100ms budget. The expensive step is buffer flush ([[BARGE-04-buffer-flush]]); the subtle step is context reconstruction ([[BARGE-05-context-reconstruction-vapi]]).

Links: [[BARGE-03-media-vs-logic-levels]] [[BARGE-04-buffer-flush]] [[BARGE-05-context-reconstruction-vapi]] [[TURN-01-vad-state-machine-hysteresis]]
