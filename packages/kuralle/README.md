# @kuralle-syrinx/kuralle

The Kuralle adapter for the Syrinx [`Reasoner`](../core/README.md#the-reasoner-seam) seam: **`fromKuralleRuntime(runtime, { sessionId }) → Reasoner`**. Drop it into [`ReasoningBridge`](../aisdk/README.md) to drive the voice pipeline with a Kuralle `Runtime` instead of a raw AI SDK backend — no pipeline change.

## Usage

```ts
import { createRuntime, defineAgent } from "@kuralle-agents/core";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { fromKuralleRuntime } from "@kuralle-syrinx/kuralle";

const runtime = createRuntime({ agents: [defineAgent({ id: "support", /* ... */ })], /* ... */ });
session.registerPlugin("bridge", new ReasoningBridge(fromKuralleRuntime(runtime, { sessionId })));
```

## How it maps

`fromKuralleRuntime` calls `runtime.run({ input: turn.userText, sessionId, ... })` and iterates `events` (an `AsyncIterable<KuralleStreamPart>`), mapping each part → `ReasoningPart`. **`turn.messages` is ignored** — Kuralle owns conversation history via `sessionId`.

| Kuralle part | → |
|---|---|
| `text-delta` (`delta`) | `text-delta` |
| `tool-call` (`toolCallId`, `toolName`, `args`) | `tool-call` |
| `tool-result` (`toolCallId`, `toolName`, `result`) | `tool-result` |
| `paused` / `interactive` | terminal `suspended` |
| `done` | `finish` (`reason: "stop"`, accumulated text) |
| `error` (`error`) | terminal `error` |
| anything else | dropped |

`KuralleRuntimeLike` is the minimal structural type the adapter needs (`run` → `events`) — the concrete `@kuralle-agents/core` `Runtime` satisfies it.

## Gotchas

- **`@kuralle-agents/core` is a `peerDependency`** — the consumer instantiates and owns the `Runtime`. The adapter only touches `run`/`events`.
- **History stays Kuralle-owned** via `sessionId`: the bridge passes only `turn.userText` per turn; do not expect Syrinx message history to reach Kuralle.
