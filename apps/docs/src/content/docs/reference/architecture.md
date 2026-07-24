---
title: Architecture
description: Packages, the four-layer transport/lifecycle/provider/runtime model, and the bus.
---

## Package map

```
packages/
  core/            VoiceAgentSession, packets, pricing, usage, spend-cap, audio codecs
  ws/              resumable WebSocketConnection (Node + Workers factories)
  stt-core/        shared streaming-STT lifecycle (SttWireProtocol)
  tts-core/        shared streaming-TTS lifecycle (WireProtocol)
  realtime/        native S2S (RealtimeAdapter + RealtimeBridge)
  deepgram/ elevenlabs/ google/ grok/ cartesia/ gemini/ openai-tts/   provider adapters
  server-websocket/  Node host + Twilio/Telnyx/SmartPBX transports
  server-workers/    Cloudflare Workers edge (Durable Objects)
  cf-agents/         withVoice(Agent) mixin
  kuralle/ aisdk/ mastra/   reasoner bridges
  vap/ pipecat-smart-turn/   turn-taking / VAP
apps/
  docs/            this documentation site (Astro + Starlight)
```

## The four layers

1. **Transport** — `ws` (resumable audio protocol), `server-websocket` (Node + carriers), `server-workers` (Workers edge). One shared `WebSocketConnection` with reconnect/replay/keepalive underneath all streaming.
2. **Streaming lifecycle** — `stt-core` / `tts-core` / `realtime`. A provider is a wire protocol; the module owns the socket, funnel, and billing.
3. **Providers** — thin adapters (Deepgram, Cartesia, ElevenLabs, …).
4. **Runtime** — `core` (`VoiceAgentSession`, the bus, pricing/usage), `cf-agents` (`withVoice`).

## The bus

Everything is a packet on a `PipelineBus`. Audio flows `user.audio_received` → (session fans to) `stt.audio` → STT → `stt.result` / `eos.turn_complete` → reasoner → `llm.delta` / `llm.done` → `tts.text` → TTS → `tts.audio`. Cross-cutting packets: `usage.recorded`, `metric.conversation`, `acoustic.signal`, `dtmf.received` / `dtmf.send`, `call.transfer`, `stt.reconfigure`. See [Packets](/reference/packets/).

## Runs on Node and Cloudflare Workers

The core is socket-free. Inject `createNodeWsSocket` (Node) or `createWorkersSocket` (Workers). On the edge, each conversation is one hibernatable Durable Object; timers become DO alarms and the session store is DO-SQLite.
