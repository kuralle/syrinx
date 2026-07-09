# Syrinx Voice Engine — Understanding + Critical Review

> Bidirectional deep-dive (top-down architecture + bottom-up primitive) reconciled with an
> adversarial fault-review, graded against the human-like-conversation bar
> (voiceaiandvoiceagents.com primer + LiveKit engineering blog + the repo's own bi-model research).
> Read-only review, 2026-07-02. Method: 10 parallel agents (2 web-research, 8 subsystem code-review),
> one full `pnpm -r test` run, and manager verification of every load-bearing finding against source.

## Primitive (one line)

The **`VoicePacket`** — `{kind, contextId, timestampMs}` — flowing over a 3-priority `PipelineBus`,
where **`contextId` doubles as the turn id**. That overload is the single most consequential design
decision in the codebase: browser transports mint a fresh contextId per turn, but **telephony reuses
one contextId for the whole call**, and multiple per-context "poison" sets clear only on `close()`.

## Map at a glance

- **Topology (cascade):** transport → `user.audio_received` → (VAD / STT / EOS) → `eos.turn_complete`
  → `ReasoningBridge(Reasoner)` streams `llm.delta` → core sentence-buffers → `tts.text` → TTS plugin
  → `tts.audio` → transport paces to client. A parallel **bi-model / realtime** path swaps the
  STT+LLM+TTS core for a `RealtimeBridge` (gpt-realtime / Gemini Live front + async kuralle reasoner back).
- **Runtimes:** Node host (`node:http` + `ws`) and Cloudflare Workers (`withVoice(Agent)`, one hibernatable
  Durable Object per conversation). The CF edge path is the flagship per the docs/product direction.
- **Transport:** WebSocket only (`syrinx.audio.v1` binary envelope, PCM16 or Opus), client-side jitter
  buffer, resumable within a 15s window. WebRTC is a deferred seam (VE-08).
- **Turn-taking:** three selectable owners — `provider_stt` (Deepgram endpointing; the shipped edge default),
  `smart_turn` (Silero VAD + Pipecat SmartTurn ONNX + semantic regex; Node only), `timer`.
- **Barge-in:** `TurnArbiter` (idle↔pending) commits at `minInterruptionMs` (280ms), gated by a
  primary-speaker fingerprint + low-confidence + backchannel suppression; fans out `interrupt.tts/llm/stt`.
- **What the project itself admits:** v2v P50 ≈ 2.1–3.6s vs its own ≤800ms SLO — the latency thesis is
  unmet, the LLM hop is the sole cause, and the fix RFC (hedging/routing/speculative start) is unbuilt.

## Top-down ↔ bottom-up

- **Agree:** the transport plumbing is genuinely sophisticated (envelope invariants, sequence/rate locks,
  paced playout, resume window, telephony byte-accounting). The Reasoner seam is clean and the aisdk
  bridge's abort/history-rewrite-to-heard-prefix is correct. Both passes rank the codebase "real engine,
  above 50-lines-of-glue" — consistent with the product-direction self-assessment.
- **Diverge → resolved:** top-down reads the barge-in truncation story as "solved" (playout_progress exists);
  bottom-up shows it is **not wired to conversation history** anywhere (`TtsPlayoutClock.positionMs` has zero
  consumers), the client never *sends* `playout_progress`, and the CF phone path has no real playout clock at
  all. Resolution: the *mechanism* exists, the *guarantee* (truncate history to what was heard) does not.
- **Diverge → resolved:** top-down treats telephony as "at parity, live-smoke tested"; bottom-up shows the
  live smokes are single-turn (`SYRINX_WS_MAX_TURNS=1`) and multi-turn Node telephony is broken three
  different ways (STT/TTS/engine poison sets). Resolution: the smokes structurally cannot reach turn 2.

## Key files (ranked)

| File | Role | Confidence |
|---|---|---|
| `packages/core/src/voice-agent-session.ts` | turn lifecycle, barge-in fan-out, per-turn state | high |
| `packages/core/src/pipeline-bus.ts` | the 3-priority bus + unbounded `allPackets`/`debugEvents` | high |
| `packages/core/src/turn-arbiter.ts` | barge-in state machine, backchannel/speaker gates | high |
| `packages/deepgram/src/stt.ts` | STT + `finalizedContextIds` drop (telephony P0) | high |
| `packages/server-websocket/src/{index,inbound-audio}.ts` | wire protocol + opus double-resample P0 | high |
| `packages/server-websocket/src/{twilio,telnyx,smartpbx,edge-twilio}.ts` | telephony adapters (drift) | high |
| `packages/tts-core/src/engine.ts` + `packages/deepgram/src/tts.ts` | TTS cancel/`cancelledContexts` leak | high |
| `packages/realtime/src/realtime-bridge.ts` | bi-model front/back, delegate pump | high |
| `packages/cf-agents/src/{with-voice,r2-recorder}.ts` | edge mixin, hibernation, recorder OOM | high |
| `docs/latency-budget.md` + `research/syrinx-product-direction.md` | the unmet thesis, self-documented | high |

## Invariants (real, and the one that's overloaded)

- Envelope: `sampleRateHz` positive int, even PCM16 length, per-context sample-rate lock, monotonic input
  sequence (dup/regress rejected). **Sound.**
- **contextId = turn id** — the overloaded one. Correct for per-turn (browser) transports; the source of the
  telephony P0 cluster for per-call transports. A `contextId + generation-epoch` would collapse most of the
  turn-boundary findings (core F3/F4/F6/F11, STT F1, TTS F1).

## Coupling hotspots

- **contextId lifecycle** spans transport ↔ core ↔ every STT/TTS plugin ↔ recorder — change it and all move.
- **playout accounting** (server-paced wire clock vs client-reported vs Twilio-buffer estimate) is three
  incompatible dialects under one protocol doc; barge-in truncation correctness depends on which one runs.
- **Node vs edge** duplicate the transport (twilio.ts vs edge-twilio.ts; index.ts vs edge.ts) with *opposite*
  contextId, pacing, and teardown behavior — behavioral drift is already shipped (see drift table in review).

## Open questions (for the maintainers)

1. Is contextId per-turn or per-call? Pick one and add a generation epoch; ~6 findings collapse.
2. Is heard-ms ever meant to truncate LLM history? If yes, the paced-vs-heard gap + absent client reports
   define the seam and must be settled before that consumer lands.
3. Is the Node browser-opus path deployed to any user? If yes, the two opus 3×-speed P0s are live-breaking.
4. Intended production telephony host — Node `twilio.ts` or `edge-twilio.ts`? Severity of the P0 cluster hinges on it.

## Suggested next command

`/rfc-writer` a "contextId → turn-epoch + heard-context-truncation" reshape (collapses the P0 cluster), then
`/feature-build` the latency RFC that already exists (`docs/rfc-reasoner-latency.md`). Full findings +
severities + prior-art gap in the review delivered alongside this artifact and in
`syrinx-critical-review-implementation-notes.md`.
