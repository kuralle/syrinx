---
id: TTS-01
title: Streaming TTS output beats whole-utterance synthesis
domain: TTS
tags: [streaming, batch, ttfb, latency]
sources: [modal-v2v, vapi-pipeline-1, together-talk, deepgram-ebook]
code_refs: [pipecat/src/pipecat/services/cartesia/tts.py:722, agents/livekit-agents/livekit/agents/tts/stream_adapter.py:89]
---

**Claim (one line):** TTS must stream audio chunks as text arrives, never wait for the whole utterance — whole-utterance synthesis adds seconds of dead air.

**Detail.** Vapi's "batch processing cascade" sends complete text to TTS and waits for the entire audio before playing, contributing to *"over 4 seconds of dead air between turns"* (vapi-pipeline-1, L9-14). The fix is to re-architect to streams and *"handle audio in 20ms chunks instead of multi-second files."* Modal: KokoroTTS *"streaming output minimizes time-to-first-byte (TTFB) at the client"* (modal-v2v L35). In code, streaming TTS opens a persistent websocket and yields audio frames incrementally: Pipecat's Cartesia `run_tts` sends the transcript over an already-open socket and returns immediately (`yield None`), audio arrives asynchronously in `_process_messages` (cartesia/tts.py:722, :668 — audio chunks appended at :690-697). Deepgram's `/v1/speak` *"supports streaming and non-streaming output"* (deepgram-ebook L2001).

**Prior-art divergence.** When a provider has no native streaming, LiveKit's `StreamAdapter` synthesizes **sentence-by-sentence** over the non-streaming API and forwards each sentence's audio as it completes (stream_adapter.py:89-137) — emulating streaming at the sentence granularity. Pipecat instead assumes a websocket streaming provider for its `WebsocketTTSService` base. Both avoid whole-utterance batch.

**Implication for Syrinx.** Default to websocket-streaming TTS; for batch-only providers, wrap them with sentence-level chunking so first audio still leaves early.

Links: [[TTS-02-ttfa-ttfb]] [[TTS-03-sentence-aggregation]] [[TTS-04-rtf]] [[wiki/tts-map]]
