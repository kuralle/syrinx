# RFC: `Reasoner` — a framework-agnostic reasoning seam for the cascading bridge

**Status:** Draft · **Author:** Syrinx · **Date:** 2026-06-05 · **Branch target:** `v2`
**Scope:** cascading (text) bridge only. **Non-goal:** the speech-to-speech / OpenAI Realtime path (deferred — see §9).

---

## 1. Summary

Generalize the LLM bridge from "wraps the Vercel AI SDK" to "drives **any** reasoning backend that streams" — concretely a Vercel AI SDK v6 `ToolLoopAgent`, a Mastra `Agent`, or a raw `streamText` — **without changing our pipeline primitive**. The bridge stays a bus-native `VoicePlugin`; only the thing it *drives* becomes a small normalized seam: a **`Reasoner`** with `stream(turn) → AsyncIterable<ReasoningPart>`. All hard-won voice behavior (conversation history, the word-timestamp **spoken-prefix barge-in**, retry, turn-superseding) is preserved verbatim.

Delivered in three reviewable steps:
1. Extract the `Reasoner` seam + a `fromAiSdkAgent` adapter, re-home today's bridge on it — **zero behavior change**; live-tested on the deployed Cloudflare worker.
2. Add a `fromMastraAgent` adapter.
3. Add the **suspend/resume** path (Mastra human-in-the-loop): a `suspended` part + a `runId` persisted in the Durable Object, resumed on a later voice turn.

---

## 2. Motivation

`AISDKBridgePlugin` (`packages/voice-bridge-aisdk/src/index.ts`) is the LLM stage of the cascade: it consumes `eos.turn_complete {text}` and emits `llm.delta` / `llm.tool_call` / `llm.tool_result` / `llm.done` packets. It is excellent — it owns history, retry, finish-reason validation, turn-superseding, and a genuinely sophisticated barge-in that rewrites history to the **spoken prefix** (what the user actually heard, via word-timestamps + playout position). But it is **welded to the AI SDK**: its only injection seam, `streamFactory`, returns `AsyncGenerator<TextStreamPart<ToolSet>>` — AI-SDK-typed.

We want callers to bind their *own* agent framework to voice. The two concrete targets:

| Backend | `.stream()` call | `.stream()` return |
|---|---|---|
| AI SDK v6 `ToolLoopAgent` | `.stream({ prompt \| messages, abortSignal })` | `StreamTextResult` → iterate `.fullStream` (`TextStreamPart`, flat) |
| Mastra `Agent` | `.stream(prompt, options)` | `MastraModelOutput` → `.processDataStream({onChunk})` (payload-wrapped); suspend via `tool-call-suspended`; resume via `resumeStream(resumeData, {runId})` |

Both have `.stream()` — but agree on **nothing else** (args, return shape, resume entry differ). So a blind `backend.stream(x)` cannot span them; per-framework glue is unavoidable. The design question is only *where that glue lives*. This RFC puts it in **named adapters** behind **one normalized seam**, leaving the bus primitive untouched.

---

## 3. Goals / Non-goals

**Goals**
- One bridge drives AI SDK `ToolLoopAgent`, Mastra `Agent`, or a raw stream.
- Keep the pipeline primitive: the bridge is still a `VoicePlugin` on the `PipelineBus`.
- Preserve all current behavior bit-for-bit in step 1 (the 9 existing bridge tests stay green).
- Cross-turn human-in-the-loop (Mastra `suspend()`/`resumeStream`) works over voice turns, with state in the Durable Object.
- Runs on Node **and** Cloudflare Workers (edge bundle stays clean of Node-only deps).

**Non-goals (this RFC)**
- The speech-to-speech / OpenAI Realtime transport. It is a **sibling** `VoicePlugin` (consumes `user.audio_received`, emits `tts.audio`), not a `Reasoner`; a `Reasoner` plugs into it later as a *delegate tool*. Deferred.
- Changing the STT/TTS plugins, the transport, the recorder, or the DO session store.
- Multi-agent routing / agent networks as first-class (they already flatten into one `agent.stream()` — see §9).

---

## 4. Design

### 4.1 The two layers (the distinction that drives everything)

- **Pipeline primitive — unchanged.** The bridge is a `VoicePlugin` (`initialize(bus, config)` / `close()`), bus-native, pushing `llm.*` packets. This is the engine's shape and stays.
- **Reasoning seam — new, tiny.** What the bridge *drives*. A normalized `Reasoner`. Frameworks become a `Reasoner` via adapters.

### 4.2 The `Reasoner` seam

```ts
// packages/voice/src/reasoner.ts  (new — lives in core so adapters/bridge share it)

/** A reasoning backend reduced to one normalized pull-stream per turn. */
export interface Reasoner {
  /**
   * Drive one reasoning turn. The returned async-iterable IS the response.
   * Cancellation (barge-in) is via `turn.signal` (abort) — the adapter forwards
   * it into the backend stream and into tool execution.
   */
  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart>;
}

export interface ReasonerTurn {
  /** Finalized user transcript for this turn (from `eos.turn_complete`). */
  readonly userText: string;
  /** Full prior conversation context. The BRIDGE owns history (see §4.5). */
  readonly messages: readonly ReasonerMessage[];
  /** Barge-in / supersede cancellation. */
  readonly signal: AbortSignal;
  /** Present only when resuming a previously-suspended run (step 3). */
  readonly resume?: { readonly runId: string; readonly data: unknown };
}

export interface ReasonerMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
}

/** Normalized output — the union of what AI SDK + Mastra can produce, minus noise. */
export type ReasoningPart =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolId: string; readonly toolName: string; readonly args: Record<string, unknown> }
  | { readonly type: "tool-result"; readonly toolId: string; readonly toolName: string; readonly result: string }
  // Human-in-the-loop pause (step 3). ALWAYS the terminal part for the turn.
  | { readonly type: "suspended"; readonly runId: string; readonly toolId?: string; readonly prompt?: string; readonly payload: unknown }
  | { readonly type: "finish"; readonly reason: "stop" | "tool" | "length"; readonly text: string };
```

The `suspended` variant is designed in **now** (zero-tech-debt — we don't want to churn the union later) even though it is only *wired* in step 3.

### 4.3 Adapters (where the per-framework glue lives)

```ts
// packages/voice-bridge-aisdk/src/from-ai-sdk.ts
export function fromAiSdkAgent(agent: AiSdkAgentLike, opts?): Reasoner;   // wraps .stream().fullStream
export function fromStreamText(config: StreamTextConfig): Reasoner;       // today's default path, as an adapter

// packages/voice-bridge-mastra/src/from-mastra.ts   (new package, step 2)
export function fromMastraAgent(agent: MastraAgentLike, opts?): Reasoner; // wraps .stream().processDataStream + resumeStream
```

**AI SDK → `ReasoningPart` mapping** (`TextStreamPart` is already what today's bridge consumes — near 1:1):

| `TextStreamPart.type` | `ReasoningPart` |
|---|---|
| `text-delta` | `{ type:"text-delta", text }` |
| `tool-call` | `{ type:"tool-call", toolId, toolName, args }` |
| `tool-result` | `{ type:"tool-result", toolId, toolName, result }` |
| `finish` | `{ type:"finish", reason, text }` |
| `tool-input-start/delta/end`, `reasoning`, `source` | dropped (no voice use) |

(`ToolLoopAgent` has no suspend → `suspended` never emitted. Resume turn throws `not supported`.)

**Mastra → `ReasoningPart` mapping** (payload-wrapped; `resume` re-enters via `resumeStream`):

| Mastra chunk | `ReasoningPart` |
|---|---|
| `text-delta` → `payload.text` | `{ type:"text-delta", text }` |
| `tool-call` → `payload.{toolCallId,toolName,args}` | `{ type:"tool-call", ... }` |
| `tool-result` → `payload.{...,result}` | `{ type:"tool-result", ... }` |
| `tool-call-suspended` → `payload.suspendPayload`, `stream.runId` | `{ type:"suspended", runId, ... }` (terminal) |
| stream end | `{ type:"finish", reason:"stop", text }` |

### 4.4 The bridge, generalized

`AISDKBridgePlugin` → `ReasoningBridge` (a `VoicePlugin`). Its constructor accepts a `Reasoner`, **or** a raw agent it auto-wraps by the stable discriminator (`"fullStream" in agent.stream(...)` ⇒ AI SDK; else Mastra):

```ts
new ReasoningBridge(reasoner)        // explicit, typed
new ReasoningBridge(toolLoopAgent)   // auto-wrapped via fromAiSdkAgent
new ReasoningBridge(mastraAgent)     // auto-wrapped via fromMastraAgent  (after step 2)
```

Everything else in `processTurn` is unchanged except the inner loop now switches on `ReasoningPart` (5 cases) instead of `TextStreamPart` (10+ cases) — strictly simpler.

### 4.5 What stays (verbatim — this is the safety property of step 1)

- **History ownership = bridge.** The bridge passes `messages` each turn; the backend is stateless-per-turn. This is *required* for barge-in: only the session knows what was *heard*, so it must be the single source of truth for "what was said." (`runId` in step 3 is the one exception — it carries Mastra's suspended-run continuity, which genuinely cannot be reconstructed.)
- **Spoken-prefix barge-in.** `computeSpokenPrefix` (word-timestamps + playout position → exact boundary, else text-sent-to-TTS) and `commitInterruptedHistory` move with the bridge, untouched.
- **Retry, idle-timeout, finish-reason validation, turn-superseding, abort-on-`interrupt.llm`.**

### 4.6 Suspend/resume across turns (step 3)

A `suspended` part is terminal: the bridge speaks `prompt` (if any), persists `{runId, contextId, payload}` in the DO (`ctx.storage.sql`, alongside `DurableObjectSessionStore`), ends the turn, and emits a `reasoning.suspended` packet. On the next user turn the orchestrator (which owns turn-routing) recognizes a pending run for the conversation and feeds a `ReasonerTurn` with `resume: { runId, data: mappedUserAnswer }`; the Mastra adapter calls `agent.resumeStream(data, {runId})`. The DO survives hibernation between turns, so the run resumes after eviction. A barged-in suspended run is discarded (drop the row). This reuses the existing turn loop + DO; the only new state is one SQL row keyed by `runId`.

---

## 5. Naming

**Seam = `Reasoner`** (`reasoner.stream(turn) → AsyncIterable<ReasoningPart>`). **Plugin = `ReasoningBridge`** (a `VoicePlugin`). **Parts = `ReasoningPart`.** **Adapters = `fromAiSdkAgent` / `fromMastraAgent`.**

Rejected:
- `StreamingReasoner` — redundant ("Reasoner" already streams); the user asked for better.
- `StreamingAgent` — collides with the very objects it wraps (`ToolLoopAgent`, Mastra `Agent`) and re-conflates the bus-node with the backend.
- `LLM` (LiveKit) / `LLMService` (Pipecat) — too narrow; the backend may be a full agent (tools, workflows, sub-agents), not a single LLM call.

`Reasoner` keeps a coherent family with the existing `llm.*`/`reasoning.*` packet vocabulary and reads correctly at the call site.

---

## 6. Alternatives considered (from the "design it twice" exploration)

Four interfaces were designed in parallel:
1. **Minimal pull-stream** (LiveKit `LLM.chat()→LLMStream`). → Adopted as the **seam shape** (`Reasoner.stream`), but it is consumed *inside* the bridge, not exposed as the primitive.
2. **Bus-native frame processor** (Pipecat / our current model). → Adopted as the **primitive** (the bridge stays a `VoicePlugin`). Rejecting it would mean a second lifecycle competing with the bus.
3. **Optimize-for-common-case** (auto-everything, duck-typed history/runStore). → Kept the *ergonomic* ("pass your agent" via auto-wrap) but **dropped the magic**: history/run persistence stay explicit, not hidden hooks.
4. **Stateful resumable run object** (LangGraph-style checkpoints). → Right *insight* (suspend/resume must checkpoint to the DO and survive hibernation), wrong *size*: expressed as a `suspended` part + a `runId` row, not a six-method run object.

**Why not "just duck-type any `.stream`":** the args, return shape, and resume entry differ between backends, so glue is unavoidable; named adapters make that glue typed, testable, and the home for suspend/resume — versus scattering `if ("fullStream" in out)` branches through the bridge.

---

## 7. Validation & testing

- **Step 1 is a refactor, not a feature:** the 9 existing tests in `packages/voice-bridge-aisdk/src/index.test.ts` must pass **unchanged** (rename imports only). That is the zero-behavior-change proof.
- New per-adapter unit tests: `TextStreamPart`/Mastra chunk → `ReasoningPart` mapping; barge-in spoken-prefix preserved; finish-reason validation; retry.
- **Edge stays clean:** `scripts/verify-edge-bundle.sh` continues to pass (no Node-only deps pulled by the new files).
- **Live proof on the deployed worker** (`https://syrinx-voice-server-workers.mithushancj.workers.dev`): the opt-in worker turn (`pnpm --filter @asyncdot/voice-server-workers test:live`, `SYRINX_LIVE_WORKER_TEST=1`) drives a real turn through the generalized bridge with an AI SDK backend (step 1) and a Mastra backend (step 2). Step 3 adds a Miniflare/workerd test that drives a **suspend → [hibernate] → resume across two turns** asserting the `runId` row survives.
- Baseline: `pnpm -r typecheck && pnpm -r test` green throughout.

---

## 8. Tiny-commits refactor plan

Each row is one atomic, independently-reviewable commit. Acceptance = the listed proof commands pass and the named invariant holds. No commit changes user-visible behavior until step 3.

### Step 1 — extract `Reasoner` + `fromAiSdkAgent`, re-home the bridge (zero behavior change)

| # | Commit | Acceptance / proof |
|---|---|---|
| 1.1 | `feat(voice): add Reasoner seam + ReasoningPart union (types only)` — `packages/voice/src/reasoner.ts`, exported from `voice/src/index.ts`. No consumers yet. | `pnpm --filter @asyncdot/voice typecheck`; new types compile, nothing references them. |
| 1.2 | `refactor(bridge): add fromAiSdkAgent + fromStreamText adapters → Reasoner` — map `TextStreamPart`→`ReasoningPart` (§4.3). Adapter unit tests. | `pnpm --filter @asyncdot/voice-bridge-aisdk test` (new adapter tests green); mapping table covered incl. dropped part types. |
| 1.3 | `refactor(bridge): drive AISDKBridgePlugin from a Reasoner internally` — replace the `streamResponse`/`fullStream` loop with `reasoner.stream(turn)` + a 5-case `ReasoningPart` switch. Keep history, spoken-prefix barge-in, retry, supersede **identical**. The constructor still accepts the AI SDK config (wraps via `fromStreamText`). | **The 9 existing `index.test.ts` tests pass UNCHANGED.** `pnpm --filter @asyncdot/voice-bridge-aisdk test`. |
| 1.4 | `refactor(bridge): accept a Reasoner or raw ToolLoopAgent; rename to ReasoningBridge` — constructor union `Reasoner \| AiSdkAgentLike \| StreamTextConfig`; auto-wrap by the `fullStream` discriminator. Keep `AISDKBridgePlugin` as a thin deprecated alias **only if** any caller needs it (prefer none — zero-debt). | `pnpm -r typecheck`; update the worker `live-session.ts` + examples to the new constructor; `pnpm -r test`. |
| 1.5 | `test(edge): live worker turn through the generalized bridge (AI SDK)` — confirm `verify-edge-bundle.sh` clean; run the opt-in live worker turn; deploy + curl one turn on the deployed worker. | `bash scripts/verify-edge-bundle.sh`; `SYRINX_LIVE_WORKER_TEST=1 pnpm --filter @asyncdot/voice-server-workers test`; deployed `/ws` turn transcribes + returns TTS. |

### Step 2 — `fromMastraAgent`

| # | Commit | Acceptance / proof |
|---|---|---|
| 2.1 | `feat(bridge-mastra): new @asyncdot/voice-bridge-mastra package` — `fromMastraAgent(agent) → Reasoner`; map `processDataStream` chunks → `ReasoningPart` (§4.3); deps `@mastra/core` (+ `@mastra/ai-sdk` only if needed). | `pnpm --filter @asyncdot/voice-bridge-mastra typecheck`. |
| 2.2 | `test(bridge-mastra): chunk→part mapping + barge-in parity` — unit tests with a scripted Mastra-shaped stream (no network). | `pnpm --filter @asyncdot/voice-bridge-mastra test`. |
| 2.3 | `feat(bridge): auto-wrap Mastra agents in ReasoningBridge` — extend the discriminator (no `fullStream` ⇒ Mastra). | `pnpm -r typecheck && pnpm -r test`; edge bundle still clean (Mastra adapter must not pull Node-only deps; gate if it does). |
| 2.4 | `test(edge): live worker turn through a Mastra-backed bridge` (opt-in, deployed). | `SYRINX_LIVE_WORKER_TEST=1 ...`; deployed turn with a Mastra agent. |

### Step 3 — `suspended` / `runId` DO path

| # | Commit | Acceptance / proof |
|---|---|---|
| 3.1 | `feat(voice): reasoning.suspended + reasoning.resume packets` — add to the packet union + factories; `ReasonerTurn.resume` already exists from 1.1. | `pnpm --filter @asyncdot/voice typecheck`; packet tests. |
| 3.2 | `feat(bridge-mastra): emit suspended part + resume re-entry` — adapter maps `tool-call-suspended`→`suspended` (terminal) and routes `turn.resume` to `agent.resumeStream(data,{runId})`. | `pnpm --filter @asyncdot/voice-bridge-mastra test` (scripted suspend→resume). |
| 3.3 | `feat(bridge): persist suspended runId, resume on next turn` — bridge handles the `suspended` part: speak `prompt`, emit `reasoning.suspended`, persist `{runId,contextId,payload}` via an injected `RunStore`; on a turn with a pending run, build `resume` turn. Barge-in on a suspended run discards it. | bridge unit tests with a fake `RunStore` (suspend→resume, barge-in-discards). |
| 3.4 | `feat(voice-server-workers): DurableObjectRunStore on ctx.storage.sql` — one `reasoning_runs` table, mirrors `DurableObjectSessionStore`; wire into the DO; alarm-GC stale rows (TTL). | `pnpm --filter @asyncdot/voice-server-workers test`. |
| 3.5 | `test(edge): suspend → hibernate → resume across two voice turns (workerd)` — Miniflare test asserting the run resumes after the DO is evicted between turns. | `pnpm --filter @asyncdot/voice-server-workers test` (the new DO suspend/resume test). |

**Rollback:** every step-1 commit is behavior-preserving, so any can be reverted independently; steps 2–3 are additive (new package / opt-in path) and revert without touching the AI SDK path.

---

## 9. Risks & open questions

- **Mastra wire shapes** (`tool-call-suspended` payload, `resumeStream` signature, `processDataStream` chunk fields) are taken from current docs, not a running build — confirm against the pinned `@mastra/core` version at step 2.1 before finalizing the mapping. (AI SDK v6 `ToolLoopAgent.stream().fullStream` is verified.)
- **Edge-bundle weight (Mastra):** `@mastra/core` may pull heavier deps; step 2.3 must keep `verify-edge-bundle.sh` green or gate Mastra to the Node build with a runtime-split export (mirror the `voice-ws` `./node` pattern).
- **History on Mastra resume runs** is dual-sourced (bridge `messages` advisory; the suspended run holds its own state under `runId`). Documented on `ReasonerTurn`; acceptable because `runId` carries the only continuity that cannot be reconstructed.
- **Who converts "next user turn" → `resume.data`?** The orchestrator (turn-routing owner), not the adapter — keeps the bridge a pure function of the turn. Confirm the mapping policy (raw text vs structured) per workflow at step 3.3.
- **Multi-agent / workflows / sub-agents** need no special handling: they flatten into one `agent.stream().fullStream`; nested agents/workflows surface as ordinary `tool-call`/`tool-result` parts, only the responding agent's `text-delta` is spoken. The sole composite-specific primitive is `suspended` (step 3).
- **Realtime / S2S** is out of scope; when added it is a sibling `VoicePlugin`, and a `Reasoner` plugs into it as a delegate tool — no change to this seam.
