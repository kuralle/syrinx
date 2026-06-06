# @kuralle-syrinx/realtime

The **bi-model** front seam for Syrinx (backlog **B-01**): a `RealtimeBridge` `VoicePlugin` that drives a
full-duplex **s2s "front" model** (OpenAI `gpt-realtime-2`) as the live conversational surface, and
delegates the "meat" (RAG / reasoning) to **any existing `Reasoner`** (the seam from
`@kuralle-syrinx/aisdk` / `mastra`) as a tool. The guardian front owns presence + speech understanding +
turn-taking; the async back owns the facts. See `docs/rfc-realtime-bridge.md` and
`bi-model-research/` for the design and the prior art (Fin Voice 2 / MoshiRAG / TML interaction models).

## What it is

- **`fromOpenAIRealtime(opts)` → `RealtimeAdapter`** — owns the `gpt-realtime-2` WebSocket (over
  `@kuralle-syrinx/ws`'s reconnecting `WebSocketConnection`). Normalizes provider events into a small
  `RealtimeEvent` union (`audio` / `speech_started` / `transcript` / `tool_call` / `response_started` /
  `response_done` / `error`). Audio is `audio/pcm` @ **24 kHz**.
- **`RealtimeBridge`** — a `VoicePlugin`. Consumes `user.audio_received` (resampled 16k→24k → provider),
  emits `tts.audio` (provider 24k→16k, chunked ≤20 ms) + `tts.end`, mints a **fresh `contextId` per turn**
  (so barge-in never permanently mutes the agent), surfaces `llm.error`, and — when given a `Reasoner` —
  runs the delegate loop on the front model's `ask_university`-style tool call and feeds the answer back
  via `function_call_output` for the front model to voice.

## Usage

```ts
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { fromStreamText } from "@kuralle-syrinx/aisdk"; // the back "meat" Reasoner

const adapter = fromOpenAIRealtime({
  apiKey: process.env.OPENAI_API_KEY!,
  socketFactory: createNodeWsSocket,            // from @kuralle-syrinx/ws/node
  // turnDetection defaults to semantic_vad; server_vad is more deterministic for tests/telephony:
  // turnDetection: { type: "server_vad", silence_duration_ms: 500 },
});

const reasoner = fromStreamText({ model, system: UNIVERSITY_SUPPORT_PROMPT, tools: { resolveLateAddRequest } });

session.registerPlugin("realtime", new RealtimeBridge(adapter, reasoner));
// run the session with endpointingOwner:"timer" — the s2s model owns turn detection,
// so NO STT/VAD/TTS plugins are registered on the live path.
```

## Capability model

`RealtimeAdapter.caps` lets the bridge adapt per provider:

| cap | gpt-realtime-2 | meaning |
|---|---|---|
| `inputSampleRateHz` / `outputSampleRateHz` | 24000 / 24000 | resample boundaries (engine is 16k) |
| `supportsConcurrentToolAudio` | `true` | native **async function calling** — the model keeps the turn fluid while the delegate runs; no double-audio observed |
| `supportsTruncate` | `true` | barge-in sends `conversation.item.truncate(audio_end_ms)` (not just `response.cancel`) |

A `fromGeminiLive` / `fromMoshi` adapter can follow with different caps (Gemini Live tool calls are
blocking → `supportsConcurrentToolAudio:false`; Moshi-class owned models could use embedding-sum injection).

## Latency (measured, honest)

From the live `gpt-realtime-2` smokes on this branch (one turn, university fixture; `server_vad`):

- **Frame round-trip** (`smoke:realtime-frame`): provider audio → resample 24k→16k → Syrinx envelope
  codec, `ok` — proves the rate-handling path adds no decode break.
- **One-turn audio** (`smoke:realtime-oneturn`): ~3.6 s assistant audio delivered through the standard
  paced `tts.audio` path.
- **Bi-model turn** (`smoke:realtime-university`): front lead-in onset ≈ first audio; `ask_university`
  tool call at ≈13.9 s into the run; university `Reasoner` answer back ≈4.2 s later; front voiced the
  grounded body — **the reasoner latency was hidden under the lead-in** (the keyword-delay-gap thesis).

**Honest characterization (not "~0"):** the bridged topology is `client ↔ Syrinx ↔ gpt-realtime-2` — one
extra WS hop + input/output resampling + per-frame bus dispatch on top of talking to the provider
directly. **Not yet measured:** a rigorous *first-audio delta* of direct-gpt-realtime-2 vs
via-`RealtimeBridge` (the WBS-5 comparison harness). Treat the delta as an open measurement; co-locate
Syrinx with the provider region to minimize the added leg.

## Status (B-01 build)

| Capability | State |
|---|---|
| `fromOpenAIRealtime` adapter + ws realtime socket | ✅ live-verified |
| `RealtimeBridge` live audio loop (fresh contextId/turn) | ✅ live-verified |
| Delegate → `Reasoner` (bi-model), `function_call_output` injection | ✅ live-verified (university turn) |
| Barge-in: `speech_started`→interrupt, `cancel`+`truncate`, abort delegate, cancel-when-idle guard | ✅ logic unit-verified + detection live-confirmed; live "resume-after-barge" smoke is flaky (orchestration) |
| First-audio direct-vs-bridged latency delta harness | ⏳ open (WBS-5) |
| `fromGeminiLive` / `fromMoshi` adapters | ⏳ future |

Tests: `pnpm --filter @kuralle-syrinx/realtime test`. Live gates (need `OPENAI_API_KEY`):
`smoke:realtime-frame` / `:realtime-oneturn` / `:realtime-university` / `:realtime-bargein` in
`examples/02-hello-voice-headless`.
