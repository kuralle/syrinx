---
id: XPORT-06
title: Jitter buffering for smooth TTS playback (~100–200 ms)
domain: XPORT
tags: [jitter, playback, buffering, pacing]
sources: [deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/voice/room_io/_output.py:45, pipecat/src/pipecat/transports/websocket/server.py:306, pipecat/src/pipecat/transports/smallwebrtc/transport.py:135, agents/livekit-agents/livekit/agents/voice/room_io/_pre_connect_audio.py:21]
---

**Claim (one line):** A small playback jitter buffer (~100 ms, up to ~200 ms) absorbs network variance without perceptible delay; servers also *pace* outbound audio to real-time so they don't flood the buffer.

**Detail.** Deepgram: "synthesized speech should be streamed incrementally and buffered just enough to prevent playback gaps. A short jitter buffer **around 100 milliseconds** is usually sufficient to smooth minor network variation without adding perceptible delay" (deepgram-ebook line 517–518). LiveKit makes this explicit: the room output `rtc.AudioSource(sample_rate, num_channels, queue_size_ms=200)` (`_output.py:45`) — a **200 ms** internal playout queue. Two pacing mechanisms keep that buffer from overfilling: (1) Pipecat's WebSocket server computes `_send_interval = (audio_chunk_size / sample_rate) / 2` and sleeps between sends to "emulate an audio device" (`server.py:306`, comment lines 270–290) so a TCP socket doesn't dump all TTS at once; (2) Pipecat's WebRTC `RawAudioTrack.recv` computes `wait = start + timestamp/sample_rate - now` and sleeps to clock frames to wall time (`transport.py:135`). LiveKit also keeps a **pre-connect audio buffer** capturing user speech before the room is fully connected, replayed once subscribed, with a `max_delta_s = 1.0` staleness guard (`_pre_connect_audio.py:22,79`) — a jitter buffer for the *connection-setup* gap rather than per-packet jitter.

**Prior-art divergence.** LiveKit exposes an explicit `queue_size_ms=200` playout buffer (WebRTC handles per-packet jitter natively). Pipecat has no separate jitter-buffer object — for WebSocket it relies on send-side pacing plus the client's own buffer; for WebRTC, aiortc/Opus provides the buffer. PSTN adds an unavoidable **100–200 ms RTT** floor (deepgram-ebook line 724) that the jitter buffer sits on top of.

**Implication for Syrinx.** Target ~100 ms playout buffer (LiveKit's 200 ms is the safe ceiling); always pace server→client audio to real-time so a fast TTS burst doesn't inflate end-to-end latency or overrun the buffer.

Links: [[XPORT-05-frame-chunk-sizing]] [[XPORT-01-ws-vs-webrtc]] [[REL-01-reconnect-exponential-backoff]] [[LAT-08-network-vs-engine-colocation]]
