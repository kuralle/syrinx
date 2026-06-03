---
id: ARCH-07
title: Thinker-talker pattern + guardrails-before-TTS
domain: ARCH
tags: [thinker-talker, latency, guardrails, filler, tool-calling]
sources: [together-talk, el-orchestration, deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_activity.py:1133]
---

**Claim (one line):** The **thinker-talker** pattern splits the LLM role: a small fast "talker" runs the live conversation and emits filler, while a big slow "thinker" (full tools/guardrails) does the real reasoning behind one tool call — buying both responsiveness and intelligence.

**Detail.** Together: "small LLM handles the live conversation, emits filler ('let me think about it') + issues one tool call to a much bigger model (full tools, more guardrails) → cleaner response → TTS" (`together-ai-engineering-voice-agents.md:43`). This exists because the streaming budget forces a model-size sweet spot of 8–30B (`together:23`); the talker stays small/fast, the thinker can be large. Filler-during-work is the universal latency-hider: ElevenLabs' **Immediate Mode + pre-tool speech** emits "Let me check that for you" *while the tool runs in parallel*, auto-extending filler to match expected wait time (`elevenlabs-orchestration-engine.md:29`); Deepgram's Think→Act injects "a brief acknowledgment" if reasoning exceeds a short threshold (`deepgram-voice-agent.parsed.md:646-648`). A hard ordering constraint applies to the talker's output: **guardrails MUST sit after LLM generation but before TTS** because "you can't take back spoken words" (`together:42`).

In code, LiveKit's `max_tool_steps=3` (`agents/.../agent_session.py:232`) and the `_generate_reply`/tool-response re-entry loop (`agent_activity.py:1133,2914`) give the multi-step think→act→respond structure; filler/pre-tool speech is the application's `say()` before a tool call. Deepgram pseudocode shows the canonical loop: `decision = llm.think(...)`; on `function_call` → `emit_state("AgentThinking")`, execute, `update_context`, then `speak(llm.respond(...))` (`deepgram-voice-agent.parsed.md:612-632`).

**Prior-art divergence.** Together frames thinker-talker as two *models*; ElevenLabs/Deepgram frame the same latency problem as *execution modes* (immediate + pre-tool speech) within one model. Both converge on "speak filler while you compute." The guardrails-before-TTS ordering is unique to Together's account but consistent with ElevenLabs' guardrails that "operate outside the agent's prompt… enforcement layer" terminating before output (`elevenlabs-orchestration-engine.md:49`).

**Implication for Syrinx (speech-plumbing scope).** Our job is the *plumbing* that makes filler work: the engine must be able to start TTS on a short filler utterance the instant a tool/long-reason begins, then cleanly splice the real response audio after — without a gap and without double-speaking. And nothing may reach TTS until the post-LLM guardrail check passes (irreversibility). Reasoning quality itself is out of scope.

Links: [[ARCH-05-batch-vs-streaming-vs-s2s]] [[ARCH-04-event-driven-lifecycle]] [[LAT-11-filler-speech]] [[TTS-03-sentence-aggregation]]
