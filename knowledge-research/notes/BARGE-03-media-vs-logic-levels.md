---
id: BARGE-03
title: Barge-in is enforced at two levels — media and logic
domain: BARGE
tags: [media, logic, cancel, two-level]
sources: [deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_activity.py:1279, pipecat/src/pipecat/transports/base_output.py:538]
---

**Claim (one line):** An interruption must stop both the *sound* (media: stop/mute outbound audio) and the *thought* (logic: cancel pending reasoning/tool execution) — stopping one without the other leaves the agent half-interrupted.

**Detail.** Deepgram states it as a rule: "Barge-in must be enforced at two levels: **Media** — Stop or mute outbound audio the moment inbound speech resumes; **Logic** — Cancel or invalidate any pending reasoning or tool execution" (deepgram-ebook ~line 739-741). Their orchestration pseudocode binds both to one event: `on_user_started_speaking(): cancel_active_action(); stop_tts_playback(); emit_state("Listening")` (deepgram-ebook ~line 649-652) — `cancel_active_action` is the logic level, `stop_tts_playback` the media level. "Long-running or asynchronous actions should always be cancelable or safely ignored if they become irrelevant" (deepgram-ebook ~line 637-638). In code, LiveKit's `interrupt()` hits both: the *media* level by interrupting current+queued `SpeechHandle`s (`agent_activity.py:1279-1287`, which stops playout) and the *logic* level by `_cancel_preemptive_generation()` (`agent_activity.py:1275`) plus `_rt_session.interrupt()`. Pipecat separates them by processor type: the output transport flushes media (`base_output.py:538`) while the LLM service / aggregators drop pending logic via the same `InterruptionFrame`.

**Prior-art divergence.** Deepgram names the two-level split explicitly; LiveKit and Pipecat realize it implicitly because the interruption broadcast reaches both the TTS/output (media) and LLM/tool (logic) processors. Pipecat additionally protects in-flight tool results with `UninterruptibleFrame` (e.g. `FunctionCallResultFrame`) so a logic-level cancel doesn't lose a result that already came back (`tts_service.py:916-918`).

**Implication for Syrinx.** Our interruption handler must abort the LLM stream AND any tool call AND stop TTS playout. A tool call that completes after barge-in must be either cancelable or safely discardable — never spoken.

Links: [[BARGE-02-interruption-sequence]] [[BARGE-04-buffer-flush]] [[BARGE-06-confidence-gated-interruption]]
