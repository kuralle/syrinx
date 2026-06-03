---
id: STT-01
title: Streaming STT vs batch — why conversational agents must stream
domain: STT
tags: [streaming, batch, latency, websocket]
sources: [deepgram-ebook, together-talk, vapi-pipeline-2]
code_refs: [pipecat/src/pipecat/services/deepgram/stt.py:632, agents/livekit-agents/livekit/agents/stt/stream_adapter.py:97]
---

**Claim (one line):** Conversational STT must run as a persistent streaming WebSocket, not per-utterance batch HTTP, because batch's "wait for the whole clip then POST" round-trip is unacceptable latency for turn-taking.

**Detail.** Deepgram's glossary states it plainly: "Streaming processes audio incrementally and emits results in real time. Batch … introduces unacceptable latency for conversational UX" (deepgram-ebook:1951-1955). The Together talk frames STT as evolving "batch → streaming"; STT latency is defined as "time to complete transcript after the user stops speaking," which Together runs at **P90 ~100ms** (together-talk:16-19). In code, streaming services hold an open socket: Pipecat's `DeepgramSTTService` opens `client.listen.v1.connect(**kwargs)` once and pushes media frames into it (`deepgram/stt.py:632`, `send_media` at `:534`), receiving results via a `MESSAGE` callback (`:685`). Batch services instead implement `recognize(buffer)` against a buffered WAV; LiveKit's `StreamAdapter` bolts streaming semantics onto a batch STT by VAD-segmenting and calling `recognize()` once per utterance (`stream_adapter.py:122-139`). Deepgram exposes two streaming endpoints: `/v1/listen` (regular streaming STT, non-Flux) and `/v2/listen` (Flux conversational streaming) (deepgram-ebook:1984-1993).

**Prior-art divergence.** Pipecat, LiveKit, and Rapida all default to **persistent WebSocket** streaming for production providers (Deepgram, Soniox). Whisper/OpenAI are inherently batch (file POST) and are wrapped: Pipecat with `SegmentedSTTService`, LiveKit with `StreamAdapter`. Modal deliberately chose batch-style segment-then-transcribe (Parakeet) over streaming (modal-v2v:33) and still hit ~1s v2v (modal-v2v:26) — see [[STT-08-segment-then-transcribe]].

**Implication for Syrinx.** Default to a streaming socket per call; only fall back to batch+VAD-gating where a provider has no streaming API, and measure on final-transcript time not partial cadence.

Links: [[STT-02-partial-final-lifecycle]] [[STT-08-segment-then-transcribe]] [[STT-09-streaming-native-vs-whisper]] [[XPORT-02-canonical-pcm-sample-rates]]
