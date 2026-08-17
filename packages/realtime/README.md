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

### Gemini Live transcription, voice, and API version

`fromGeminiLive` keeps both transcription directions enabled by default and makes each one
configurable (set either to `false` to disable it):

```ts
const adapter = fromGeminiLive({
  apiKey,
  transcription: { input: true, output: true },
  speechConfig: { voice: "Kore", languageCode: "en-US" },
  apiVersion: "v1alpha",
});
```

The adapter maps these options to Gemini Live's `inputAudioTranscription`,
`outputAudioTranscription`, and `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` setup fields.
The server reports both transcripts in `serverContent.inputTranscription` and
`serverContent.outputTranscription`, which become `{ type: "transcript", role, text, final }` events.

Google's [Live API capabilities guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
currently documents input transcription as unsupported by Gemini 3.1 Flash Live Preview. When using
that model, enabling `transcription.input` will not produce user transcripts; use a Live model that
supports input transcription or a separate STT provider when user transcripts are required. Native
audio models also choose their output language automatically, so `languageCode` is intended for models
that support explicit language selection. See Google's [API version guide](https://ai.google.dev/gemini-api/docs/api-versions)
for version semantics; `apiVersion` is applied at SDK client level because Live does not support
request-level HTTP options.

### Gemini Live NON_BLOCKING tool calls and generator responses

A tool declared with `behavior: "NON_BLOCKING"` on `RealtimeToolDef` runs without holding the
turn — the front model keeps listening and speaking while it runs, instead of going silent for
the duration of the call:

```ts
const adapter = fromGeminiLive({
  apiKey,
  tools: [{
    name: "consult_knowledge",
    description: "Answer knowledge questions.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    behavior: "NON_BLOCKING",
  }],
});
```

`injectToolResult(toolId, text, opts)` accepts `opts.scheduling` (`"SILENT" | "WHEN_IDLE" |
"INTERRUPT"`, when the late result re-enters the turn) and `opts.willContinue` (send several
responses for the same `toolId` as a generator: `willContinue: true` for each intermediate
"still looking" response, then a terminal one — `willContinue` absent or `false` — to finish
the call). Both options are per-adapter — declared on `RealtimeAdapter.injectToolResult` itself
so every implementation's signature stays compatible, but only meaningful when
`caps.supportsToolBehavior` is true (Gemini Live today; Vertex does not support `willContinue`).

Per `@google/genai@2.8.0`, an empty `response` with `willContinue: false` finishes the call but
may still trigger model generation. To finish the call without triggering generation, also pass
`scheduling: "SILENT"`:

```ts
adapter.injectToolResult(toolId, "", { willContinue: false, scheduling: "SILENT" });
```

A generator sequence is not required to complete before the front model's own turn does —
`turnComplete` can fire while a call is still open, and the server still honours a later
response for that `toolId` sent after it. The map entry that resolves a tool id therefore
releases only on that call's terminal response (or on `toolCallCancellation` / adapter
`close()`), never on `turnComplete`.

## The Responder-Thinker primitive (the delegate seam)

The bi-model shape has a name: **Responder-Thinker** — a fast realtime **responder** on the audio
loop, an async reasoning/RAG **thinker** behind it, delegated to via one tool. `RealtimeBridge` +
`Reasoner` *is* this architecture, and the delegate seam ships with four built-in behaviors
(RFC `docs/rfc-bimodel-delegate-seam.md`) so a consumer never hand-rolls them:

- **G1 — structured result envelope (default).** The thinker's answer reaches the responder as
  authoritative JSON — `{ response_text, require_repeat_verbatim: true, render? }`
  (`DelegateResultEnvelope`, OpenAI's documented *Tool Output Formatting* shape) — so the front
  voices it faithfully instead of paraphrasing or inventing. Options:
  `toolResultFormat: "envelope" | "string"` (default `"envelope"`), `renderDirective` (e.g.
  `"translate_faithfully"`). Applied synchronously to the already-buffered delegate answer —
  latency-neutral; bus packets keep the raw answer.
- **G2 — delegate observability.** The bridge emits `delegate.query` / `delegate.result`
  (Background route) around every `reasoner.stream(...)`: query, answer, `durationMs`,
  `grounded` (the stream surfaced a `tool-result` part). Subscribe on the bus — or via
  `VoiceAgentSession`'s `delegate_query` / `delegate_result` events — instead of wrapping the
  `Reasoner` to log.
- **G3 — typed preamble/filler lifecycle.** `VoiceAgentSession` turns each delegate tool call into
  a `tool_call_cue` lifecycle — `started` (before the thinker runs) / `delayed` (time-triggered
  "still working" after `delayCueAfterMs`) / `complete` / `failed` (error, barge-in, supersede) —
  and the WS transports surface it as `tool_call_*` wire messages the standard clients parse.
  Decoupled from any blocking-tool contract: it wraps the thinker-latency window itself.
- **G4 — durable session + resume.** `caps.supportsNativeResume` splits providers: Gemini Live
  resumes server-side (`sessionResumptionHandle` option in + `resumption_handle` events out —
  never replay on top of it); OpenAI-compatible fronts replay via `resumeHistory: () => [...]`
  (sent as `conversation.item.create` after every (re)connect's `session.update`, never a
  `response.create` — a resumed session cannot double-answer). The thinker side re-seeds from a
  `ReasonerSessionStore` (`@kuralle-syrinx/core`), DO-SQLite-backed in `@kuralle-syrinx/cf-agents`.

On Cloudflare, `withVoice(Agent)` (`@kuralle-syrinx/cf-agents`) wires all four up turnkey — a new
consumer supplies a front + a `Reasoner` and gets envelope + observability + cues + durable resume
for free.

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
| `fromGeminiLive` adapter (incl. native session resume) | ✅ shipped |
| Responder-Thinker delegate seam: envelope + observability + cues + durable resume | ✅ shipped (RFC bimodel-delegate-seam) |
| `fromMoshi` adapter | ⏳ future |

Tests: `pnpm --filter @kuralle-syrinx/realtime test`. Live gates (need `OPENAI_API_KEY`):
`smoke:realtime-frame` / `:realtime-oneturn` / `:realtime-university` / `:realtime-bargein` in
`examples/02-hello-voice-headless`.
