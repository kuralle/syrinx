---
id: XPORT-08
title: Transport-layer keepalive and stall detection
domain: XPORT
tags: [keepalive, ping, session-timeout, stall-detection, silence]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/transports/websocket/server.py:235, pipecat/src/pipecat/transports/base_transport.py:73, pipecat/src/pipecat/transports/smallwebrtc/transport.py:140, pipecat/src/pipecat/transports/base_transport.py:72]
---

**Claim (one line):** Keep the audio transport alive by continuously emitting silence frames (so the stream never goes idle), and treat a stalled input/output stream as a failure to recover from — at the protocol level use WebSocket ping/pong and session timeouts.

**Detail.** Deepgram: "Backend components should monitor audio flow and message cadence. If input or output stalls, the system should treat it as a failure and initiate recovery" (ebook line 596–597). The clones realize "never let the stream go idle" via **auto-silence**: Pipecat's transport defaults `audio_out_auto_silence = True` (`base_transport.py:73`) — when the output queue is empty it injects silence frames rather than letting the socket fall silent; the WebRTC `RawAudioTrack.recv` emits `bytes(self._bytes_per_10ms)` of silence when its queue is empty (`transport.py:140`). This keeps a continuous 10 ms cadence on the wire, which doubles as a heartbeat and prevents the far-end jitter buffer from underrunning. After an `EndFrame`, `audio_out_end_silence_secs = 2` (`base_transport.py:72`) flushes a 2 s silence tail so the last word isn't clipped. At the connection level, Pipecat's WebSocket server runs a `_monitor_websocket` task that sleeps `session_timeout` and fires `on_session_timeout` (`server.py:201,235`) to reap dead sessions. WebSocket native ping/pong is delegated to the `websockets` library defaults.

**Prior-art divergence.** Pipecat's keepalive is application-layer (silence frames + session-timeout monitor), not relying solely on TCP/WS ping. WebRTC (LiveKit, Pipecat smallwebrtc) gets connection liveness from ICE/DTLS consent-freshness for free, so it leans less on app-layer pings. Deepgram frames keepalive as part of **reliability/recovery** (ebook line 588–598) — stall detection feeds reconnect-with-backoff, not just connection hygiene.

**Implication for Syrinx.** Emit continuous silence on idle output (heartbeat + jitter-buffer protection); run a per-session stall watchdog on both input and output cadence that triggers reconnect, distinct from raw TCP/WS ping.

Links: [[XPORT-06-jitter-buffer-playback]] [[XPORT-01-ws-vs-webrtc]] [[REL-01-reconnect-exponential-backoff]] [[REL-09-backpressure-load]]
