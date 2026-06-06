# @kuralle-syrinx/mastra

The Mastra adapter for the Syrinx [`Reasoner`](../core/README.md#the-reasoner-seam) seam: **`fromMastraAgent(agent) → Reasoner`**. Drop it into [`ReasoningBridge`](../aisdk/README.md) to drive the voice pipeline with a Mastra `Agent` instead of a raw AI SDK backend — no pipeline change.

## Usage

```ts
import { Agent } from "@mastra/core/agent";
import { createOpenAI } from "@ai-sdk/openai";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { fromMastraAgent } from "@kuralle-syrinx/mastra";

const agent = new Agent({
  name: "support",
  instructions: "You are a helpful voice assistant.",
  model: createOpenAI({ apiKey })("gpt-4.1-mini"),
});
session.registerPlugin("bridge", new ReasoningBridge(fromMastraAgent(agent)));
```

## How it maps

`fromMastraAgent` awaits `agent.stream(messages)` and iterates `output.fullStream` (a `ReadableStream<{type,payload}>`), mapping each chunk → `ReasoningPart`:

| Mastra chunk | → |
|---|---|
| `text-delta` (`payload.text`) | `text-delta` |
| `tool-call` (`payload.{toolCallId,toolName,args}`) | `tool-call` |
| `tool-result` (`payload.{toolCallId,toolName,result}`) | `tool-result` |
| `tool-call-suspended` (`payload.suspendPayload`, `output.runId`) | terminal `suspended` (Sprint 3 / suspend-resume) |
| `finish` (`payload.stepResult.reason`) | `finish` (stop/tool/length) or terminal `error` for abnormal reasons |
| `error` (`payload.error`) | terminal `error` |
| anything else | dropped |

Verified against `@mastra/core@1.41.0`. A `turn.resume` routes to `agent.resumeStream(data, {runId})` instead of `stream(...)`. No buffering — each chunk is yielded immediately.

`MastraAgentLike` is the minimal structural type the adapter needs (`stream` + `resumeStream`) — the concrete `@mastra/core` `Agent` satisfies it.

## Gotchas

- **`@mastra/core` is a `peerDependency`** — the consumer instantiates and owns the `Agent` (and its Mastra version). The adapter only touches `stream`/`resumeStream`/`fullStream`/`runId`.
- **Node / `nodejs_compat` only.** `@mastra/core` imports `events`/`fs`/`path`/`crypto` and won't bundle for a plain browser/edge target (`--platform=browser`). On Cloudflare Workers it requires `nodejs_compat` (see `@kuralle-syrinx/server-workers-mastra`). The lean AI-SDK product worker deliberately keeps Mastra out of its bundle.
- **History stays bridge-owned** (RFC §4.5): run the agent stateless-per-turn (no Mastra memory) so the bridge's spoken-prefix barge-in remains authoritative.
