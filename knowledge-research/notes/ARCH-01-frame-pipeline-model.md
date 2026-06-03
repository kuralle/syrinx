---
id: ARCH-01
title: The streaming frame-pipeline model (processors + frames + transports)
domain: ARCH
tags: [pipeline, frames, processors, transport, streaming]
sources: [modal-v2v, deepgram-ebook, together-talk]
code_refs: [pipecat/src/pipecat/pipeline/pipeline.py:91, pipecat/src/pipecat/processors/frame_processor.py:175]
---

**Claim (one line):** A streaming voice engine is a linear chain of stateless **FrameProcessors** that pass typed **Frames** bidirectionally, bracketed by a **transport** node at each end — not a request/response cascade.

**Detail.** Modal frames the framework as the thing that turns three stateless inference calls (STT→LLM→TTS) into a stateful real-time loop, and names Pipecat's three primitives: *processors* handle real-time audio/text/video *frames*, and "each pipeline starts and ends with a transport node managing the real-time media connection" (`modal-one-second-voice-to-voice.md:16`). In code, `Pipeline.__init__` wraps the user processor list with a `PipelineSource` and `PipelineSink` and links them into a doubly-linked chain via `_link_processors()` (`pipecat/src/pipecat/pipeline/pipeline.py:113-121,207-212`). Each `FrameProcessor` holds `_prev`/`_next` pointers (`frame_processor.py:211-212`) and `link()` wires them (`frame_processor.py:536-544`). Frames flow `DOWNSTREAM` (input→output) or `UPSTREAM` (acks/errors) per `FrameDirection` (`frame_processor.py:56-65`); `push_frame()` forwards to `_next` or `_prev` accordingly (`frame_processor.py:702,878-902`). Every processor runs frames in its own asyncio task, guaranteeing per-processor ordering (`frame_processor.py:181-183`).

**Prior-art divergence.** Deepgram describes the same chain as a managed *single persistent WebSocket loop* (Tier-1 baseline) where "all conversational intelligence lives in the agent runtime" and the client is a thin edge (`deepgram-voice-agent.parsed.md:1344-1357`) — i.e. the pipeline is hidden server-side rather than expressed as user-owned processors. Pipecat (open graph) exposes every node; Vapi/Deepgram-managed hide it. Together's talk calls this the "pipeline / cascading architecture" and names Pipecat/LiveKit/homegrown as the orchestrator slot (`together-ai-engineering-voice-agents.md:11-12`).

**Implication for Syrinx.** Our engine should be a linked chain of single-responsibility processors with transport nodes at the edges; resist collapsing stages into a monolith — the modularity is what lets us swap STT/TTS and instrument per-stage latency.

Links: [[ARCH-02-frame-taxonomy]] [[ARCH-03-system-vs-data-frame-ordering]] [[ARCH-04-event-driven-lifecycle]] [[ARCH-08-livekit-agentsession]] [[wiki/arch-map]]
