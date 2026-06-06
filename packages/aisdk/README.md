# @kuralle-syrinx/aisdk

The LLM stage of the Syrinx cascade as a bus-native `VoicePlugin` — **`ReasoningBridge`** — plus the AI SDK adapters that turn a Vercel AI SDK backend into the normalized [`Reasoner`](../core/README.md#the-reasoner-seam) seam it drives.

`ReasoningBridge` consumes `eos.turn_complete`, drives one `reasoner.stream(turn)` per turn, and emits `llm.delta` / `llm.tool_call` / `llm.tool_result` / `llm.done` (or `llm.error` → retry) packets. It owns conversation history, the word-timestamp **spoken-prefix barge-in**, retry, finish-reason validation, and turn-superseding — none of which change when you swap the backend.

## Adapters

```ts
import { fromAiSdkAgent, fromStreamText, fromStreamFactory } from "@kuralle-syrinx/aisdk";

fromAiSdkAgent(agent)        // wraps (await agent.stream({messages, abortSignal})).fullStream
fromStreamText(config)       // raw `streamText` config as a Reasoner
fromStreamFactory(factory)   // an AISDKStreamFactory (async generator of TextStreamPart) — the test seam
```

All three map the full `ai@6` `TextStreamPart` union → `ReasoningPart` through one no-buffering generator: `text-delta`/`tool-call`/`tool-result` pass through; `error`/`tool-error`/`abort` and `finish-step`/`finish` with abnormal reasons become a terminal `error` part (driving the bridge's retry/`llm.error` path); everything else is dropped. No buffering — each part is yielded the instant the backend produces it (the §7a latency invariant).

## Usage

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs } from "ai";
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";

const bridge = new ReasoningBridge(fromStreamText({
  model: createOpenAI({ apiKey })("gpt-4.1-mini"),
  system: "You are a helpful voice assistant.",
  temperature: 0.4,
  maxOutputTokens: 256,
  maxRetries: 0,
  timeout: 30_000,
  stopWhen: stepCountIs(1),
}));
session.registerPlugin("bridge", bridge);
```

The constructor takes a **`Reasoner` only** — wrap your backend explicitly with the matching adapter. There is **no auto-wrap / `.stream()`-probe**. Provider config (model, system, temperature, tools, …) lives in the adapter; the plugin config holds only `timeout_ms` / `max_history_turns` / retry.

## Suspend/resume (optional)

```ts
new ReasoningBridge(reasoner, { runStore, onResumeConflict: "restart" });
```

- `runStore?: RunStore` — a `{ save(contextId, runId), takePending(contextId), discard(contextId) }` pointer store ("which conversation has a pending suspended run"). Without it, suspend/resume is inert.
- `onResumeConflict` (default `"restart"`) — on barge-in over a pending run, the pointer is discarded and the question is re-asked fresh (never resume a checkpoint that diverged from the corrected spoken-prefix history). `"replay"` is reserved (throws "not yet supported").

A `RunStore` implementation is provided by `@kuralle-syrinx/server-workers-mastra` (`DurableObjectRunStore`, SQL on `ctx.storage.sql`).

## Gotcha

The bridge is the single source of truth for history (the backend is stateless-per-turn) — this is what makes spoken-prefix barge-in correct. Don't give the backend its own conversation memory; pass `turn.messages`.
