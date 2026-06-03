---
id: ARCH-10
title: The Voice-Engine / Agent-Orchestration boundary (transcript-out, response-in)
domain: ARCH
tags: [boundary, voice-engine, orchestration, scope, transcript]
sources: [el-fde, el-orchestration, deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent.py:462, voice-ai/api/assistant-api/internal/type/communication.go:35]
---

**Claim (one line):** ElevenLabs splits the stack into a **Voice Engine** (STT, turn-taking, interruption detection → emits transcript) and an **Agent Orchestration** layer (LLM reasons over prompt/KB/RAG); the clean interface is **transcript-out / response-text-in** — and Syrinx's scope is the Voice Engine half.

**Detail.** The key architecture diagram: "the Voice Engine handles audio orchestration (speech-to-text, turn taking, interruption detection) and passes transcripts to the Agent Orchestration layer, where an LLM reasons over a system prompt, knowledge base, and RAG" (`elevenlabs-voice-agents-that-last-fde.md:12`). ElevenLabs further splits *each side* by predictability: traditional-software components (telephony, versioning) improve via "caching, connection pooling, infrastructure scaling, protocol optimization — reliable levers with deterministic outcomes," whereas core-orchestrator latency "is less deterministic… model inference times, injection of auditory artifacts, tool-call chains" (`el-fde:14-16`). Deepgram draws the same line as a two-layer stack: a **core conversational layer** (listen/reason/speak) and an **operational layer** (scale/observability/compliance) (`deepgram-voice-agent.parsed.md:175-205`).

This boundary is visible in every clone: it is exactly the `llm_node` seam. LiveKit's `Agent.llm_node` consumes a `chat_ctx` (text) and yields text chunks (`agents/.../agent.py:462-483`) — STT/turn-detection sit upstream (engine), LLM/tools sit at/after it (orchestration). Rapida's `Communication` interface is the orchestration-side contract (assistant config, histories, knowledge retrieval, LLM `Callback`) sitting *behind* the STT/TTS `Transformers` and VAD/EOS engine stages (`voice-ai/.../type/communication.go:35-82`). Cloudflare's `onTurn(transcript, context)` is the literal handoff point: engine produces `transcript`, orchestration returns a `TextSource` (`cloudflare-agents/packages/voice/src/voice.ts:136`). ElevenLabs' own orchestrator note operates entirely on the text side — "which model sees what tokens, and when" (`el-orchestration:5`).

**Prior-art divergence.** ElevenLabs/Deepgram make the boundary explicit as a product split; LiveKit/Pipecat blur it (the same pipeline owns both halves, the seam is just a node), which is why their interruption/turn logic can reach across it. The split's value is operational: the engine half has deterministic latency levers, the orchestration half needs eval frameworks.

**Implication for Syrinx.** Hold the line at transcript-out / response-in. Everything upstream of `llm_node` (STT, VAD, endpointing, interruption, transport, TTS plumbing) is ours to harden with deterministic levers; LLM reasoning quality is explicitly *not* our domain. The egress mirror — response-text-in → TTS → audio-out — is equally ours (sentence aggregation, streaming TTFA, resampling).

Links: [[ARCH-04-event-driven-lifecycle]] [[ARCH-08-livekit-agentsession]] [[ARCH-09-rapida-cloudflare-runtimes]] [[ARCH-07-thinker-talker]] [[STT-01-streaming-vs-batch]] [[TTS-01-streaming-vs-batch]]
