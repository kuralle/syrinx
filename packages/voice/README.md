# @asyncdot/voice

The Syrinx Kernel v2 — the framework-agnostic core of the voice engine: the `PipelineBus`, the `VoicePlugin` contract, the packet vocabulary (`stt.*` / `llm.*` / `tts.*` / `reasoning.*` …), turn-taking, observability, and the latency-hiding/barge-in primitives. STT/TTS/bridge/transport packages plug into this bus.

This README documents the **`Reasoner` seam** added for the Reasoner-bridge generalization; the rest of the kernel surface is in `src/index.ts`.

## The Reasoner seam

A normalized pull-stream that lets one bridge ([`ReasoningBridge`](../voice-bridge-aisdk/README.md)) drive **any** reasoning backend (Vercel AI SDK `ToolLoopAgent`/`streamText`, Mastra `Agent`, …) without changing the pipeline primitive. Defined in `src/reasoner.ts`:

```ts
export interface Reasoner {
  // Drive one turn. The returned async-iterable IS the response.
  // LATENCY INVARIANT: yield every part the instant the backend produces it —
  // no buffering, no awaiting to completion, no batching.
  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart>;
}

export interface ReasonerTurn {
  readonly userText: string;                       // finalized transcript (from eos.turn_complete)
  readonly messages: readonly ReasonerMessage[];   // prior context — the BRIDGE owns history
  readonly signal: AbortSignal;                    // barge-in / supersede
  readonly resume?: { readonly runId: string; readonly data: unknown };  // suspend/resume only
}

export type ReasoningPart =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolId: string; toolName: string; result: string }
  | { type: "suspended"; runId: string; toolId?: string; prompt?: string; payload: unknown }  // terminal (HITL)
  | { type: "error"; cause: Error; recoverable: boolean }                                       // terminal (→ retry)
  | { type: "finish"; reason: "stop" | "tool" | "length"; text: string };
```

Frameworks become a `Reasoner` via **named adapters** (never auto-wrap / duck-typing):
- AI SDK → `fromAiSdkAgent` / `fromStreamText` / `fromStreamFactory` (`@asyncdot/voice-bridge-aisdk`)
- Mastra → `fromMastraAgent` (`@asyncdot/voice-bridge-mastra`)

The bridge (a `VoicePlugin`) consumes the seam and pushes `llm.*` packets; the seam adds at most one microtask + a synchronous object remap per part. History, spoken-prefix barge-in, retry, and turn-superseding all stay in the bridge — the backend is stateless-per-turn.

See `docs/rfc-reasoner-bridge.md` for the full design.
