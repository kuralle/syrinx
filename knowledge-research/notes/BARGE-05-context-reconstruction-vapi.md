---
id: BARGE-05
title: Context reconstruction — keep history synced to words actually heard
domain: BARGE
tags: [context, word-timestamps, history, playout, truncation]
sources: [vapi-pipeline-2]
code_refs: [agents/livekit-agents/livekit/agents/voice/transcription/synchronizer.py:294, agents/livekit-agents/livekit/agents/voice/agent_activity.py:2424, pipecat/src/pipecat/processors/aggregators/llm_response_universal.py:1880]
---

**Claim (one line):** When the user barges in, the assistant's conversation history must be truncated to *exactly the words the user actually heard* before the cut — otherwise the LLM thinks it said sentences that never reached the speaker.

**Detail.** Vapi calls this "the trickiest" problem: "Use word-level timestamps from the TTS provider to reconstruct exactly which words the user actually heard before they interrupted, keeping conversation context synchronized with the user's experience" (vapi-pipeline-2 line 56). The mechanism differs across the two clones (compared in detail in [[BARGE-08-spoken-word-truncation-livekit-vs-pipecat]]). LiveKit's transcript synchronizer maintains `forwarded_text` — the prefix of the response whose words have been emitted at the current playback position — and on interruption `synchronized_transcript` returns `forwarded_text` (the played prefix) rather than the full pushed text (`synchronizer.py:294-299`). `AgentActivity` then writes *that* into the chat context: on `speech_handle.interrupted` it sets `forwarded_text = playback_ev.synchronized_transcript` and calls `add_message(role="assistant", content=forwarded_text, interrupted=True)` (`agent_activity.py:2415-2448`). Pipecat reaches the same end-state differently: its assistant aggregator builds context only from `TextFrame`s that actually flowed to playout (`llm_response_universal.py:1880-1901`), and word-level `TTSTextFrame`s are gated by PTS at the output ([[BARGE-08-spoken-word-truncation-livekit-vs-pipecat]]).

**Prior-art divergence.** Vapi reconstructs from *TTS-provider word timestamps*; LiveKit reconstructs from *playback position × estimated speaking rate* (no provider timestamps required). Same goal, different signal source. Deepgram's prose ("preserves conversational trust") implies it but gives no mechanism.

**Implication for Syrinx.** We must record an assistant turn as the *played* prefix, not the *generated* text. The signal can be TTS word timestamps (Vapi) or playback-clock + rate (LiveKit) — pick based on whether our TTS provider emits reliable word timing.

Links: [[BARGE-08-spoken-word-truncation-livekit-vs-pipecat]] [[BARGE-02-interruption-sequence]] [[TTS-11-word-timestamps]] [[STT-02-partial-final-lifecycle]]
