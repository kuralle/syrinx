---
id: ARCH-09
title: Where orchestration state lives — Rapida's stateful Talker vs Cloudflare's durable-object agent
domain: ARCH
tags: [runtime, state, durable-object, talker, dispatcher, session]
sources: [modal-v2v, deepgram-ebook]
code_refs: [voice-ai/api/assistant-api/internal/type/communication.go:35, cloudflare-agents/packages/agents/src/index.ts:1342]
---

**Claim (one line):** Modal's "framework = long-running stateful process storing conversation history" shows up two ways: **Rapida** as a per-call `Talker`/`Communication` goroutine behind a `Dispatcher`, **Cloudflare** as a hibernatable **Durable Object** (one DO instance per conversation) with SQLite-backed state and a `withVoice` mixin.

**Detail.** Modal's rationale: STT/LLM/TTS APIs are stateless/RESTful, so the framework is "a long-running stateful process storing conversation history" (`modal-one-second-voice-to-voice.md:11`).

**Rapida (Go).** A `channel_pipeline.Dispatcher` is wired with callbacks: `OnResolveSession → OnCreateStreamer → OnCreateTalker → OnRunTalk → OnCreateObserver → OnCompleteSession` (`voice-ai/api/assistant-api/socket/pipeline.go:36-83`). Per call it resolves a `CallContext`, builds a transport `Streamer`, then a `Talking` adapter and calls `talker.Talk(ctx, auth)` (`pipeline.go:69-74`) — a `for{}` loop that pumps the conversation (`internal/adapters/internal/stream.go:32-34`). The stateful per-conversation contract is the **`Communication`** interface: it carries `Assistant()`, `Conversation()`, `GetHistories() []MessagePacket`, metadata/args, knowledge retrieval, and embeds the LLM `Callback` + `InternalCaller` (`internal/type/communication.go:35-82`). Stages are `Transformers[AudioPacket]` (STT) / `Transformers[TextPacket]` (TTS) plus VAD/`end_of_speech`/denoiser/normalizer dirs (`internal/` tree). State lives in the goroutine + Postgres/Redis.

**Cloudflare (TS).** `Agent` extends partyserver's `Server`, i.e. a **Durable Object** (`cloudflare-agents/packages/agents/src/index.ts:1342-1346`); `static options = { hibernate: true }` by default (`index.ts:1533,1112-1166`), and state persists in DO storage SQL (`this.ctx.storage.sql.exec`, `index.ts:1622-1819`). The voice path is the `withVoice(Agent)` mixin: per-connection `transcriber` session created at call start, `onTurn(transcript, context)` returns a `TextSource`, streamed through a `SentenceChunker` into a per-sentence TTS queue (`packages/voice/src/voice.ts:20-22,133-162,951-989`). Conversation history is persisted to SQLite (`maxMessageCount` default 1000, `historyLimit` 20) (`voice.ts:110-121`). One DO instance == one conversation == the unit of state and addressability.

**Prior-art divergence.** Rapida keeps state in a live goroutine + external DB and is telephony-first (SIP/WebSocket streamers, `socket/pipeline.go`). Cloudflare co-locates state *and* compute in a single hibernatable DO per conversation — the edge/serverless answer to Together's "stateful long-lived connections… can't kill pods arbitrarily, must drain" problem (`together-ai-engineering-voice-agents.md:34`): a DO can hibernate between turns instead of holding a pod. Deepgram's managed Tier-1 runtime is the third answer — state lives entirely inside the provider's agent runtime over one WebSocket (`deepgram-voice-agent.parsed.md:1350-1352`).

**Implication for Syrinx.** Decide deliberately where conversation state lives: live process (Rapida — simple, but scaling = drain problem), durable object per conversation (Cloudflare — hibernation solves idle cost + addressability), or managed runtime. The `Communication`-style single contract (one object exposing history + assistant config + callers) is a clean way to thread state through every stage without globals.

Links: [[ARCH-01-frame-pipeline-model]] [[ARCH-04-event-driven-lifecycle]] [[ARCH-08-livekit-agentsession]] [[ARCH-10-voice-engine-orchestration-boundary]] [[REL-07-connection-draining-scaledown]] [[TTS-03-sentence-aggregation]]
