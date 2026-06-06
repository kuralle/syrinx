# openai-agents-js transport layer — notes + mapping to Syrinx

> Grounding for the "should we adopt `@openai/agents/realtime` / learn from its transport" decision.
> Sources (fetched 2026-06-06): voice-agents guide (`developers.openai.com/api/docs/guides/voice-agents`),
> transport guide + Cloudflare extension (`openai.github.io/openai-agents-js/...`).

## openai-agents-js model
- **`RealtimeSession` + `RealtimeAgent`** = the orchestration + agent (tools, handoffs, guardrails).
- **`RealtimeTransportLayer`** = pluggable transport interface. Events: `audio`, `audio_interrupted`,
  `turn_started`/`turn_completed`, tool-call events (`TransportToolCallEvent`); methods to send audio/events,
  `interrupt()`, connect. Audio via `TransportLayerAudio` / `RealtimeAudioFormat`.
- Built-in transports: **`OpenAIRealtimeWebRTC`** (browser default), **`OpenAIRealtimeWebSocket`**
  (server/Node default), base `OpenAIRealtimeBase`; transport auto-selected by runtime, overridable via
  `RealtimeSessionOptions.transport`.
- Extensions: **Twilio** (`OpenAIRealtimeSIP`/Twilio layer), AI SDK, and **Cloudflare**.
- **`CloudflareRealtimeTransportLayer`** (`@openai/agents-extensions`): opens the OpenAI realtime socket from
  workerd via `fetch()` + `Upgrade: websocket`, **skipping the socket `open` event** (matches workerd). All
  session features work over it. `new RealtimeSession(agent, { transport: new CloudflareRealtimeTransportLayer({ url }) })` then `session.connect({ apiKey })`.
- Voice-agents guide: two architectures — **speech-to-speech (realtime)** vs **chained STT→LLM→TTS**;
  realtime for low-latency/barge-in, chained for durable transcripts/approval flows. No Workers example in
  the core guide (the Cloudflare path is the extension above).

## Direct equivalences to Syrinx (we already have most of this)
| openai-agents-js | Syrinx equivalent |
|---|---|
| `RealtimeTransportLayer` (interface) | `RealtimeAdapter` (`packages/realtime`) — our `RealtimeEvent` union ≈ their transport events |
| `OpenAIRealtimeWebSocket` | `fromOpenAIRealtime` + `@kuralle-syrinx/ws` `RealtimeSocket`/`createNodeWsSocket` |
| `CloudflareRealtimeTransportLayer` (fetch-upgrade) | `@kuralle-syrinx/ws` `createWorkersSocket` — **already does the same fetch()+Upgrade+accept(), skip-open pattern** |
| `RealtimeSession` (turn/interrupt/tool orchestration) | `RealtimeBridge` (VoicePlugin) + `VoiceAgentSession` (bus) |
| `RealtimeAgent` (the brain/tools) | the **`Reasoner` seam** (back "meat" — aisdk/mastra) — but ours is bi-model (front s2s + separate back), theirs is one agent |
| Twilio/SIP extension | `@kuralle-syrinx/server-websocket` Twilio/Telnyx/SmartPBX carrier adapters (paced playout, mark/clear, DTMF) |

## What's NOT in openai-agents-js that Syrinx has (our moat)
- **Bi-model**: front s2s + a *separate* async RAG/reasoning back model (the Reasoner-as-delegate). Theirs is
  one OpenAI agent.
- **Provider-neutral front**: our `RealtimeAdapter` targets OpenAI + (planned) Grok/Gemini/Moshi. Theirs is
  OpenAI-only transports (+Twilio carrier).
- **The bus / kernel**: PipelineBus routes, recorder (R2 stereo stems), telephony carrier nuances, latency
  budget, resumable WS protocol.

## What openai-agents-js does that we should consider learning
- A **richer transport event model** (turn lifecycle, mute, explicit interrupt) vs our compact union.
- **Runtime-based transport auto-selection** (WebRTC browser / WS server / Cloudflare) behind one interface.
- **Ephemeral client secrets** for browser/edge auth (we use raw key server-side only).
- The Cloudflare transport's **skip-open** detail (our `createWorkersSocket` already does this).

## Tension for "adopt by default"
Adopting `@openai/agents/realtime` as the default front would: pull a large OpenAI-coupled dep, subsume our
provider-neutral `RealtimeAdapter` + our bus, and not give us the bi-model/RAG or carrier/recorder story it
lacks. But its WS/Cloudflare transports are battle-tested and could be wrapped as ONE optional adapter
(`fromOpenAIAgentsTransport`) for teams already in that ecosystem. The decision is build / adopt / hybrid.
