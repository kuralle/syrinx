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

## Two modes (and how the back model plugs in)

The `RealtimeBridge` runs in two modes; the back "meat" model plugs in via the **`Reasoner` seam** — the
*same* framework adapters the cascade `ReasoningBridge` uses (`@kuralle-syrinx/aisdk`'s
`fromStreamText`/`fromAiSdkAgent`/`fromStreamFactory`, `@kuralle-syrinx/mastra`'s `fromMastraAgent`). You
pass the **`Reasoner`**, not the `ReasoningBridge` plugin (the bridge runs it as a delegate tool and feeds
the result back for the front model to voice — using the `ReasoningBridge` plugin here would double-speak).

```ts
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

const adapter = fromOpenAIRealtime({
  apiKey: process.env.OPENAI_API_KEY!,
  socketFactory: createNodeWsSocket,
  // turnDetection defaults to semantic_vad; server_vad is more deterministic for tests/telephony.
  // tools: [...]  // domain tools the front model may call — supplied by YOU, never hardcoded here.
});

// (1) STANDALONE — pure s2s, the realtime model answers from its own knowledge:
session.registerPlugin("realtime", new RealtimeBridge(adapter));

// (2) BI-MODEL with an AI SDK back (the "meat"):
import { fromStreamText } from "@kuralle-syrinx/aisdk";
const aiReasoner = fromStreamText({ model, system, tools: { resolveLateAddRequest } });
const adapterA = fromOpenAIRealtime({ ...opts, tools: [{ name: "ask_kb", description: "...", parameters: {/*JSON Schema*/} }] });
session.registerPlugin("realtime", new RealtimeBridge(adapterA, aiReasoner, "ask_kb"));

// (3) BI-MODEL with a Mastra back — identical wiring, just a different Reasoner factory:
import { fromMastraAgent } from "@kuralle-syrinx/mastra";
const mastraReasoner = fromMastraAgent(myMastraAgent);
session.registerPlugin("realtime", new RealtimeBridge(adapterA, mastraReasoner, "ask_kb"));
```

Run the session with `endpointingOwner:"timer"` — the s2s model owns turn detection, so NO STT/VAD/TTS
plugins are registered on the live path. The **delegate tool is caller-supplied**: pass the tool def to
the adapter (`tools`) and its name as the bridge's 3rd arg (`delegateToolName`); the adapter is fully
domain-neutral (it never hardcodes any tool). The same `Reasoner` backends also power the cascade
`ReasoningBridge` — only the front (s2s vs STT→TTS) differs.

## Deploy on Cloudflare Workers

`@kuralle-syrinx/realtime` is **edge-clean**: no `Buffer`, `process`, or `node:crypto` in `src/`. The
adapter is **provider-socket-agnostic** — inject whichever `@kuralle-syrinx/ws` factory your runtime needs.
On Workers, outbound provider WebSockets that require auth headers use the fetch-upgrade path via
`createWorkersSocket` (not the global `WebSocket` constructor, which cannot set headers).

Wire secrets through the Worker **`env` binding** (Wrangler secrets / vars), not `process.env`. Pass
`apiKey` and `debug` as constructor options:

```ts
import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";

/** Bound in wrangler.jsonc / dashboard — e.g. OPENAI_API_KEY secret. */
export interface Env {
  readonly OPENAI_API_KEY: string;
}

export function createRealtimeVoiceSession(env: Env): VoiceAgentSession {
  const adapter = fromOpenAIRealtime({
    apiKey: env.OPENAI_API_KEY,
    socketFactory: createWorkersSocket,
    debug: false,
    turnDetection: { type: "semantic_vad" },
  });

  const session = new VoiceAgentSession({
    endpointingOwner: "timer",
    plugins: { realtime: {} },
  });
  session.registerPlugin("realtime", new RealtimeBridge(adapter));
  return session;
}
```

**Durable Object session shape** (see `packages/server-workers`): the Worker `fetch` handler routes
`/ws?sessionId=…` to a `VoiceConversation` Durable Object. The DO accepts the client upgrade via
`WebSocketPair`, constructs the `VoiceAgentSession` (cascade or bi-model realtime — same env-injection
pattern), and pumps audio over the accepted socket. Provider outbound legs (OpenAI Realtime, Deepgram,
Cartesia, …) all dial through `createWorkersSocket` so auth headers ride on the fetch upgrade.

Regression lock: `edge-safety.test.ts` runs the adapter + bridge with `Buffer` and `process` removed from
`globalThis`.

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
