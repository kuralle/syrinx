---
id: XPORT-01
title: WebSocket vs WebRTC for carrying voice audio
domain: XPORT
tags: [transport, webrtc, websocket, telephony, browser]
sources: [modal-v2v, diagrams, deepgram-ebook]
code_refs: [pipecat/src/pipecat/transports/smallwebrtc/transport.py:76, pipecat/src/pipecat/transports/websocket/server.py:418, pipecat/src/pipecat/serializers/twilio.py:32]
---

**Claim (one line):** Use WebRTC for the lossy/variable client link (browser, mobile) and a WebSocket for server↔server and telephony-gateway hops; the two coexist in one bot.

**Detail.** Modal's stack splits exactly this way: **client ↔ bot over WebRTC** (Pipecat JS client + Python `SmallWebRTCTransport` on `aiortc`), **bot ↔ STT/TTS over persistent WebSockets** (modal-v2v lines 40–41; diagrams "Modal architecture" line 30–38). WebRTC owns the unreliable last mile because it brings congestion control, NACK/PLC, jitter buffering, and Opus baked in; WebSocket (TCP) owns the reliable backbone hops where ordered delivery matters and head-of-line blocking is acceptable. Telephony is a third case: the carrier (Twilio) terminates PSTN and bridges to the runtime over a **WebSocket** carrying base64 µ-law (deepgram-ebook line 706–722; `twilio.py:32`). In Pipecat the choice is a swappable transport node — `RawAudioTrack` (smallwebrtc `transport.py:76`) emits Opus-bound 10ms AudioFrames for WebRTC; `WebsocketServerTransport` (`server.py:418`) ships serialized frames over a raw socket. Deepgram notes WebSocket concurrency limits are a primary scaling constraint for telephony (ebook line 764).

**Prior-art divergence.** Pipecat ships both first-class and lets you swap "to a proprietary network (Daily mesh) or Twilio in a few lines" (modal-v2v line 17). LiveKit is WebRTC-native end-to-end (room model, `room_io/`). Cloudflare's telephony providers (Twilio/Telnyx) are WebSocket-only bridges into a Durable Object. Rapida (voice-ai clone) implements its own realtime audio transports: an application-level WebRTC streamer (`voice-ai/api/assistant-api/internal/channel/webrtc/streamer.go` — pion/webrtc v4, registers Opus with `useinbandfec=1`) plus a SIP/telephony pipeline (`sip/pipeline/`) and WebSocket carrier handlers (Telnyx/Exotel) — i.e. it spans all three transport modes, not a RAG/document service.

**Implication for Syrinx.** Don't force one transport. WebRTC to the browser, WebSocket to STT/TTS and to telephony carriers — and keep the serializer layer decoupled so the same pipeline serves both.

Links: [[XPORT-02-canonical-pcm-sample-rates]] [[XPORT-07-twilio-media-streams-serialization]] [[XPORT-08-transport-keepalive]] [[LAT-08-network-vs-engine-colocation]]
