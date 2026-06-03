---
id: REL-03
title: Application-layer keepalive for idle streaming sockets
domain: REL
tags: [keepalive, session-timeout, idle, websocket, ping]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/services/deepgram/stt.py:652, pipecat/src/pipecat/services/deepgram/stt.py:640, agents/livekit-agents/livekit/agents/utils/connection_pool.py:24]
---

**Claim (one line):** Streaming providers close sockets that go quiet, so when there is no audio to send (user silent / agent thinking) you must send explicit keepalive messages on a fixed sub-timeout cadence, or the provider reaps the connection mid-conversation.

**Detail.** Deepgram: "Long-lived streaming sessions require explicit keepalive mechanisms and graceful reconnection handling to maintain conversational continuity" (ebook line 2094-2095). The concrete numbers are in Pipecat's Deepgram STT: *"Deepgram closes inactive connections after 10 seconds (NET-0001 error). Sending every 5 seconds stays within the recommended 3-5 second interval."* The `_keepalive_handler` loops `await asyncio.sleep(5)` and sends `ListenV1KeepAlive(type="KeepAlive")` (`deepgram/stt.py:652-663`); the task is spawned only when keepalive is enabled and cancelled on disconnect (line 640-650). This is **application-layer** (a provider-defined JSON message), distinct from WS protocol ping/pong. Separately, LiveKit's `ConnectionPool` does *proactive* reconnection: a pooled session older than `max_session_duration` is discarded and rebuilt on next `get()` (`connection_pool.py:24-38, 108-111`) — pre-empting provider-side max-lifetime cutoffs rather than reacting to them.

**Prior-art divergence.** Two complementary keepalive strategies: (1) **send-keepalive-on-idle** (Pipecat Deepgram, 5 s) keeps an *active* socket from being reaped during silence; (2) **proactive-recycle** (LiveKit ConnectionPool, `max_session_duration`) rotates a socket *before* it hits a hard lifetime limit. [[XPORT-08-transport-keepalive]] covers a third: continuous silence frames on the *output* path as a wire heartbeat + jitter-buffer guard. All three answer "don't let the socket die," at different layers.

**Implication for Syrinx.** Every streaming STT/TTS socket needs an idle keepalive pegged below the provider's idle-timeout (Deepgram 10 s ⇒ send at 5 s). Add proactive session recycling for providers with a hard max-lifetime so reconnects happen between turns, not mid-utterance.

Links: [[REL-01-reconnect-exponential-backoff]] [[XPORT-08-transport-keepalive]] [[REL-05-stall-detection-audio-cadence]] [[REL-10-failure-mode-catalog]]
