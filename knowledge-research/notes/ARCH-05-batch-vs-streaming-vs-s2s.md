---
id: ARCH-05
title: Batch-cascade vs streaming-cascade vs speech-to-speech (S2S) trade-offs
domain: ARCH
tags: [cascade, streaming, s2s, latency, trade-offs]
sources: [vapi-pipeline-1, deepgram-ebook, together-talk, modal-v2v]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_activity.py:190, agents/livekit-agents/livekit/agents/voice/agent.py:462]
---

**Claim (one line):** Three architectural eras — **batch cascade** (~4s dead air, dead), **streaming cascade** (dominant production pattern, ~1s v2v), and **speech-to-speech** (full-duplex, preserves prosody, but weak tool-calling) — trade latency, controllability, and expressive fidelity.

**Detail.**
- **Batch cascade ("Batch Processing Cascade"):** sequential `STT(wait)→NLP(wait)→TTS(wait)`; each stage waits for the previous to fully complete. "This cascade of waiting creates over 4 seconds of dead air between turns" (`vapi-pipeline-1.md:9-14`). Rejected.
- **Streaming cascade:** re-architect to process audio in **20ms chunks** instead of multi-second files (`vapi-pipeline-1.md:18`); stages overlap. This is "the dominant production pattern" — "cascade systems remain the dominant production pattern… mature tooling, interpretable debugging boundaries, proven operational characteristics" (`deepgram-voice-agent.parsed.md:181-188`). Together: pipeline/cascading is the dominant pattern (`together-ai-engineering-voice-agents.md:11`). Modal hits **~1s median v2v** with a streaming cascade (`modal-one-second-voice-to-voice.md:50`).
- **S2S:** one model does audio↔audio + tool-calling (OpenAI Realtime, NVIDIA voice chat, Deepgram Neuroplex). Benefits: simpler (no multi-model orchestration), **preserves tone/emotion/hesitation** lost to text, **full-duplex** (backchannels), natively better barge-in (`together-ai-engineering-voice-agents.md:37-38`). Deepgram: "I guess so" keeps hesitant/sarcastic/enthusiastic nuance that text collapses to one transcript (`deepgram-voice-agent.parsed.md:1731-1735`). **But not production-ready: weak instruction-following + tool-calling** → teams prompt-engineer then fall back to pipeline (`together:38`; `deepgram:1786-1789`).

LiveKit is the clearest code witness that *both* coexist behind one API: `AgentActivity` branches on `isinstance(self.llm, llm.RealtimeModel)` to pick S2S vs cascade, with mode `"realtime_llm"` vs `"stt"` turn detection (`agents/.../agent_activity.py:190-287`); `Agent.llm_node` asserts non-realtime for the cascade path (`agents/.../agent.py:470-473`). Pipecat similarly has `RealtimeServiceMetadataFrame` for S2S services (`pipecat/.../frames.py:1442`).

**Prior-art divergence.** Deepgram's Neuroplex is the differentiated S2S bet: "end-to-end trainable but modular by design," operating on dense latent vectors via learned adapters (ASR2LLM, LLM2T2C) with inspectable debug tokens — addressing S2S's opaque-failure/steerability problems (`deepgram:1740-1781`). Everyone else treats S2S as an external model (OpenAI Realtime) plugged into the same orchestrator slot.

**Implication for Syrinx.** Build streaming-cascade first (mature, debuggable, ~1s achievable). Keep the LLM slot pluggable so an S2S RealtimeModel can drop in later behind the same session API (LiveKit's pattern), but do not bet on S2S for tool-heavy workflows yet.

Links: [[ARCH-01-frame-pipeline-model]] [[ARCH-04-event-driven-lifecycle]] [[ARCH-06-three-parallel-streams]] [[ARCH-07-thinker-talker]] [[ARCH-08-livekit-agentsession]] [[LAT-01-v2v-figure-of-merit]]
