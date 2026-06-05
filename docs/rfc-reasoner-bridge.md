# RFC: `Reasoner` — a framework-agnostic reasoning seam for the cascading bridge

**Status:** Draft v2.1 (revised after a cross-family review — pi-glm / GLM 5.1) · **Author:** Syrinx · **Date:** 2026-06-05 · **Branch target:** `v2`
**Scope:** cascading (text) bridge only. **Non-goal:** the speech-to-speech / OpenAI Realtime path (deferred — see §9).

> **v2.1 changelog (review fixes):** B1 — `ReasoningPart` gains an `error` variant; the AI SDK `error`/`tool-error`/`finish-step` parts now map to it instead of being dropped (they drive retry). B2 — added `fromStreamFactory`; the "9 tests unchanged" claim is corrected (assertions unchanged, the construction line adapts). B3 — **auto-wrap dropped**; callers wrap explicitly with `fromAiSdkAgent` / `fromMastraAgent` (the `"fullStream" in agent.stream()` discriminator was broken — `stream()` returns a `Promise` — and it contradicted §6). B4 — explicit spoken-prefix reconciliation policy on Mastra resume. M3 — latency gate now measures *no regression vs our own baseline on a stable local harness* (`smoke:websocket-interactive`), not a delta against a literature budget or the noisy deployed worker.

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
   *
   * LATENCY INVARIANT (non-negotiable, see §7a): the adapter MUST yield every
   * part the instant the backend produces it — NO buffering, NO awaiting the
   * stream to completion, NO batching. The first `text-delta` must reach the
   * caller as soon as the backend's first token lands. The seam adds at most one
   * microtask + a synchronous object remap per part; it must add no I/O hop.
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
  // (B1) Error/abort the backend surfaced. The bridge treats `error` like today's
  // thrown TextStreamPart `error`/`tool-error`/`finish-step(error)`: it drives the
  // retry/`llm.error` path. `recoverable` mirrors `categorizeLlmError`. ALWAYS terminal.
  | { readonly type: "error"; readonly cause: Error; readonly recoverable: boolean }
  | { readonly type: "finish"; readonly reason: "stop" | "tool" | "length"; readonly text: string };
```

The `suspended` and `error` variants are designed in **now** (zero-tech-debt — we don't want to churn the union later); `suspended` is only *wired* in step 3, `error` is wired in step 1 (it carries the retry-triggering throws today's bridge depends on — see B1, §4.3).

### 4.3 Adapters (where the per-framework glue lives)

```ts
// packages/voice-bridge-aisdk/src/from-ai-sdk.ts
export function fromAiSdkAgent(agent: AiSdkAgentLike, opts?): Reasoner;       // wraps (await agent.stream()).fullStream
export function fromStreamText(config: StreamTextConfig): Reasoner;           // raw streamText, as an adapter
// (B2) Preserves today's test seam: the current bridge is constructed with an
// `AISDKStreamFactory` (an `async function*`). All 9 existing tests use it, so the
// seam must survive as a Reasoner adapter — otherwise "behavior unchanged" is a lie.
export function fromStreamFactory(factory: AISDKStreamFactory): Reasoner;     // async-generator of TextStreamPart → Reasoner

// packages/voice-bridge-mastra/src/from-mastra.ts   (new package, step 2)
export function fromMastraAgent(agent: MastraAgentLike, opts?): Reasoner;     // wraps .stream().processDataStream + resumeStream
```

**AI SDK → `ReasoningPart` mapping.** `agent.stream()` returns a `Promise<StreamTextResult>` (B3 — the adapter `await`s it, then iterates `.fullStream`). The full `ai@6` `TextStreamPart` union is mapped — **the error/abort parts are NOT dropped**, because today's bridge throws on them to trigger retry:

| `TextStreamPart.type` | `ReasoningPart` |
|---|---|
| `text-delta` | `{ type:"text-delta", text }` |
| `tool-call` | `{ type:"tool-call", toolId, toolName, args }` |
| `tool-result` | `{ type:"tool-result", toolId, toolName, result }` |
| `error`, `tool-error`, `abort` | `{ type:"error", cause, recoverable }` (terminal — drives retry/`llm.error`) **(B1)** |
| `finish-step` (with `finishReason: error`/`content-filter`) | `{ type:"error", … }` **(B1)** — matches the current `processTurn` step-validation throw |
| `finish` | `{ type:"finish", reason, text }` |
| `tool-input-start/delta/end`, `reasoning`, `source`, raw | dropped (no voice use) |

(`ToolLoopAgent` has no suspend → `suspended` never emitted. A `resume` turn throws `not supported`.)

**Mastra → `ReasoningPart` mapping** (payload-wrapped; `resume` re-enters via `resumeStream`):

| Mastra chunk | `ReasoningPart` |
|---|---|
| `text-delta` → `payload.text` | `{ type:"text-delta", text }` |
| `tool-call` → `payload.{toolCallId,toolName,args}` | `{ type:"tool-call", ... }` |
| `tool-result` → `payload.{...,result}` | `{ type:"tool-result", ... }` |
| `tool-call-suspended` → `payload.suspendPayload`, `stream.runId` | `{ type:"suspended", runId, ... }` (terminal) |
| stream end | `{ type:"finish", reason:"stop", text }` |

### 4.4 The bridge, generalized

`AISDKBridgePlugin` → `ReasoningBridge` (a `VoicePlugin`). Its constructor accepts a **`Reasoner` only** — callers wrap their backend explicitly with the matching adapter:

```ts
new ReasoningBridge(fromAiSdkAgent(toolLoopAgent))   // AI SDK
new ReasoningBridge(fromMastraAgent(mastraAgent))    // Mastra (after step 2)
new ReasoningBridge(fromStreamText(config))          // raw streamText
new ReasoningBridge(fromStreamFactory(asyncGenFn))   // the existing test seam (B2)
```

**(B3) No auto-wrap / duck-typing.** An earlier draft accepted a raw agent and detected the backend with `"fullStream" in agent.stream(...)`. That is broken — `agent.stream()` returns a `Promise` (so `"fullStream" in` it is always false), and using a *side-effecting network call* as a type probe is wrong regardless. It also contradicted §6 ("explicit adapters, not duck-type magic"). The explicit-adapter call site costs one wrapper and removes the failure mode entirely. (If a one-liner is later wanted, it is a pure-shape factory like `reasoningBridge(agent, { kind: "ai-sdk" })`, never a probe that calls `.stream()`.)

Everything else in `processTurn` is unchanged except the inner loop now switches on `ReasoningPart` (6 cases incl. `error`) instead of `TextStreamPart` (10+ cases) — still simpler, and the `error` case routes to the exact retry/`llm.error` path the current code takes on a thrown part (§4.5, B1).

### 4.5 What stays (verbatim — this is the safety property of step 1)

- **History ownership = bridge.** The bridge passes `messages` each turn; the backend is stateless-per-turn. This is *required* for barge-in: only the session knows what was *heard*, so it must be the single source of truth for "what was said." (`runId` in step 3 is the one exception — it carries Mastra's suspended-run continuity, which genuinely cannot be reconstructed.)
- **Spoken-prefix barge-in.** `computeSpokenPrefix` (word-timestamps + playout position → exact boundary, else text-sent-to-TTS) and `commitInterruptedHistory` move with the bridge, untouched.
- **Retry, idle-timeout, finish-reason validation, turn-superseding, abort-on-`interrupt.llm`.**

### 4.6 Suspend/resume across turns (step 3)

A `suspended` part is terminal: the bridge speaks `prompt` (if any), persists `{runId, contextId, payload}` in the DO (`ctx.storage.sql`, alongside `DurableObjectSessionStore`), ends the turn, and emits a `reasoning.suspended` packet. On the next user turn the orchestrator (which owns turn-routing) recognizes a pending run for the conversation and feeds a `ReasonerTurn` with `resume: { runId, data: mappedUserAnswer }`; the Mastra adapter calls `agent.resumeStream(data, {runId})`. The DO survives hibernation between turns, so the run resumes after eviction. A barged-in suspended run is discarded (drop the row). This reuses the existing turn loop + DO; the only new state is one SQL row keyed by `runId`.

**(B4) Spoken-prefix reconciliation on resume — the one genuinely subtle correctness issue.** The barge-in correction (`commitInterruptedHistory`) rewrites the *bridge's* `messages` to the spoken prefix — what the user actually heard. But a Mastra agent that suspended holds its **own** checkpoint, and `resumeStream(data, {runId})` restores *that* uncorrected state. So if, between a suspend and its resume, an *earlier* assistant turn was barged-in, the agent's internal memory still believes it said the full reply — diverging from the bridge's corrected history and silently defeating the project's signature feature. §9's old "dual-sourced, acceptable" framing was wrong. Policy:
- **Default — `restart`:** if any spoken-prefix correction landed on a turn within the suspended run's context since it suspended, **discard the suspended run** (drop the row, no `resumeStream`) and re-issue the question as a fresh turn carrying the corrected `messages`. Correct by construction; costs one extra model turn in the rare suspend-then-barge-in overlap.
- **Opt-in — `replay`:** for backends that accept it, replay the bridge's corrected `messages` into the resumed run (Mastra: pass corrected history alongside `resumeData`) so the checkpoint is reconciled in place. Cheaper, but depends on the backend honoring an injected history on resume — verify per backend before enabling.

This only bites when **barge-in and suspend/resume coincide in the same conversation** (an edge case), but it is a real divergence, not a wash. The reconciliation mode is a `ReasoningBridge` option (`onResumeConflict: "restart" | "replay"`, default `restart`).

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
3. **Optimize-for-common-case** (auto-everything, duck-typed history/runStore). → **Dropped entirely** (B3). An interim draft kept a single ergonomic — auto-wrapping a raw agent — but that required a `.stream()`-probe discriminator which is both broken (returns a `Promise`) and side-effecting. Callers wrap explicitly with `fromAiSdkAgent`/`fromMastraAgent`. One extra wrapper; zero magic; no probe.
4. **Stateful resumable run object** (LangGraph-style checkpoints). → Right *insight* (suspend/resume must checkpoint to the DO and survive hibernation), wrong *size*: expressed as a `suspended` part + a `runId` row, not a six-method run object.

**Why not "just duck-type any `.stream`":** the args, return shape, and resume entry differ between backends, so glue is unavoidable; named adapters make that glue typed, testable, and the home for suspend/resume — versus scattering `if ("fullStream" in out)` branches through the bridge.

---

## 7. Validation & testing

- **Step 1 is a refactor, not a feature. (B2)** The 9 existing tests in `packages/voice-bridge-aisdk/src/index.test.ts` each construct `new AISDKBridgePlugin(async function*(){…})` — an `AISDKStreamFactory`. Their **assertions and behavior stay byte-for-byte identical**; the *only* change is the construction line `new AISDKBridgePlugin(fn)` → `new ReasoningBridge(fromStreamFactory(fn))` (a mechanical, one-line-per-test edit that preserves the exact streamed sequence). "Pass unchanged" was imprecise — the *test logic* is unchanged, the *constructor call* adapts. That is still the zero-behavior-change proof: same inputs, same asserted outputs.
- New per-adapter unit tests: `TextStreamPart`/Mastra chunk → `ReasoningPart` mapping (**including the `error`/`tool-error`/`finish-step` → `error` paths — B1**); barge-in spoken-prefix preserved; finish-reason validation; retry triggered by an `error` part.
- **Edge stays clean:** `scripts/verify-edge-bundle.sh` continues to pass (no Node-only deps pulled by the new files).
- **Live proof on the deployed worker** (`https://syrinx-voice-server-workers.mithushancj.workers.dev`): the opt-in worker turn (`pnpm --filter @asyncdot/voice-server-workers test:live`, `SYRINX_LIVE_WORKER_TEST=1`) drives a real turn through the generalized bridge with an AI SDK backend (step 1) and a Mastra backend (step 2). Step 3 adds a Miniflare/workerd test that drives a **suspend → [hibernate] → resume across two turns** asserting the `runId` row survives.
- Baseline: `pnpm -r typecheck && pnpm -r test` green throughout.

---

## 7a. Latency (hard requirement — the seam must add ~0)

Latency is the engine's top product constraint. Industry budgets for natural conversation:

| Source | Voice-to-voice budget | LLM time-to-first-token | TTS time-to-first-byte |
|---|---|---|---|
| Daily — *Voice AI & Voice Agents primer* | ~**800 ms** total (STT 300 / **LLM-TTFT 350** / TTS-TTFB 120 / net 10); "good conversational" ~500 ms | ~350 ms | ~120 ms |
| Modal — *One-second voice-to-voice* | ~**1000 ms** (good ≤1000, bad ≥2000) | ~500 ms | ~200 ms |

The bridge sits on the **LLM-TTFT** stage and sets the streaming cadence into TTS — the single most latency-sensitive seam in the pipeline. The `Reasoner` abstraction therefore must be a **transparent passthrough**, not a stage that adds time.

**Why the overhead is negligible (by construction):**
- The adapter is `for await (part of backend) yield map(part)` — it forwards each part immediately. Cost added per part = **one microtask hop** (async-generator yield) **+ a synchronous object remap** (`TextStreamPart`/Mastra chunk → `ReasoningPart`). That is microseconds against a ~350 ms LLM-TTFT — i.e. < 0.01% of the stage, well inside measurement noise.
- **No buffering, no completion-await, no batching, no extra network hop.** The first `text-delta` propagates the instant the backend emits its first token, so TTFT and first-sentence-to-TTS are unchanged.
- **Mastra's callback stream** (`processDataStream({onChunk})`) is bridged to an async-iterable via a zero-delay queue — each `onChunk` enqueues and resolves the pending pull immediately; it must never accumulate.
- Sentence aggregation (`llm.delta` → `tts.text`) is **unchanged** and still lives in the session orchestrator, so TTS-TTFB is unaffected.

**Measurable acceptance (not asserted — instrumented). (M3)** The numbers above (~350 ms LLM-TTFT, etc.) are *literature budgets*, not our baseline — and the deployed worker's LLM-TTFT is far higher and network-noisy (real provider RTT, observed on the order of ~1.3 s), so "within a few ms of 350 ms" is meaningless against that floor. The gate is therefore framed as **no regression vs *our own* captured baseline on a stable, repeatable local harness** — not the literature budget, and not the noisy deployed worker:

1. **Capture the baseline before step 1** on the pre-refactor `main`/`v2` HEAD using `pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-interactive`, which already reports per-stage **LLM-TTFT P50/P95** over a fixed scripted run. Record the numbers (commit them under `docs/latency-budget.md`).
2. **After each step**, re-run the *same* harness on the *same* fixture and assert **LLM-TTFT P50 and P95 are within the run-to-run variance band of that baseline** (establish the band from 3 baseline runs; typical target ≤ ~5 % or a few ms, whichever is larger). A regression beyond the band is a blocker — the refactor is rejected, not merged.
3. The deployed-worker turn (step 1.5) is a *functional* live proof (transcribes + returns TTS), **not** the latency gate — its variance is too high to gate on.

This gates step 1, step 2 (Mastra adapter), and step 3 (the suspend path must not add latency to *non-suspending* turns).

## 8. Tiny-commits refactor plan

Each row is one atomic, independently-reviewable commit. Acceptance = the listed proof commands pass and the named invariant holds. No commit changes user-visible behavior until step 3.

### Step 1 — extract `Reasoner` + `fromAiSdkAgent`, re-home the bridge (zero behavior change)

| # | Commit | Acceptance / proof |
|---|---|---|
| 1.1 | `feat(voice): add Reasoner seam + ReasoningPart union (types only)` — `packages/voice/src/reasoner.ts`, exported from `voice/src/index.ts`. No consumers yet. | `pnpm --filter @asyncdot/voice typecheck`; new types compile, nothing references them. |
| 1.0 | `chore(latency): capture pre-refactor LLM-TTFT baseline` **(M3)** — run `smoke:websocket-interactive` ×3 on `v2` HEAD; record LLM-TTFT P50/P95 + the variance band in `docs/latency-budget.md`. | baseline committed; band documented. This is the denominator every later latency gate compares against. |
| 1.1 | `feat(voice): add Reasoner seam + ReasoningPart union (types only)` — `packages/voice/src/reasoner.ts` incl. the `error` and `suspended` variants (B1); exported from `voice/src/index.ts`. No consumers yet. | `pnpm --filter @asyncdot/voice typecheck`; the union matches RFC §4.2 (incl. `error`). |
| 1.2 | `refactor(bridge): add fromAiSdkAgent + fromStreamText + fromStreamFactory adapters → Reasoner` — map the full `TextStreamPart` union → `ReasoningPart` (§4.3), **including `error`/`tool-error`/`finish-step` → `error` (B1)** and `fromStreamFactory` for the existing test seam (B2). Adapter unit tests. | `pnpm --filter @asyncdot/voice-bridge-aisdk test` (new adapter tests green); mapping table covered incl. the **error paths** and dropped part types. |
| 1.3 | `refactor(bridge): drive AISDKBridgePlugin from a Reasoner internally` — replace the `streamResponse`/`fullStream` loop with `reasoner.stream(turn)` + a 6-case `ReasoningPart` switch (incl. `error` → the existing retry/`llm.error` path, B1). Keep history, spoken-prefix barge-in, retry, supersede **identical**. **No buffering** — yield each part immediately (§7a). | **The 9 `index.test.ts` tests: assertions unchanged; each construction line adapts `new AISDKBridgePlugin(fn)` → `new ReasoningBridge(fromStreamFactory(fn))` (B2).** `pnpm --filter @asyncdot/voice-bridge-aisdk test`. **LLM-TTFT P50/P95 within the baseline band** from 1.0 (§7a/M3). |
| 1.4 | `refactor(bridge): rename to ReasoningBridge; accept a Reasoner only (no auto-wrap)` **(B3)** — constructor takes a `Reasoner`; callers wrap via `fromAiSdkAgent`/`fromStreamText`/`fromStreamFactory`. **No `.stream()`-probe discriminator.** Update `live-session.ts` + examples to the explicit wrap. Remove `AISDKBridgePlugin` (zero-debt) or keep a thin alias only if a caller needs it. | `pnpm -r typecheck && pnpm -r test`; no call site uses auto-wrap. |
| 1.5 | `test(edge): live worker turn through the generalized bridge (AI SDK)` — confirm `verify-edge-bundle.sh` clean; run the opt-in live worker turn; deploy + drive one turn on the deployed worker (functional proof). Re-run `smoke:websocket-interactive` for the **latency gate** (M3) — the deployed turn is NOT the latency gate. | `bash scripts/verify-edge-bundle.sh`; `SYRINX_LIVE_WORKER_TEST=1 pnpm --filter @asyncdot/voice-server-workers test`; deployed `/ws` turn transcribes + returns TTS; **`smoke:websocket-interactive` LLM-TTFT within the 1.0 baseline band**. |

### Step 2 — `fromMastraAgent`

| # | Commit | Acceptance / proof |
|---|---|---|
| 2.1 | `feat(bridge-mastra): new @asyncdot/voice-bridge-mastra package` — `fromMastraAgent(agent) → Reasoner`; map `processDataStream` chunks → `ReasoningPart` (§4.3); deps `@mastra/core` (+ `@mastra/ai-sdk` only if needed). | `pnpm --filter @asyncdot/voice-bridge-mastra typecheck`. |
| 2.2 | `test(bridge-mastra): chunk→part mapping + barge-in parity` — unit tests with a scripted Mastra-shaped stream (no network). | `pnpm --filter @asyncdot/voice-bridge-mastra test`. |
| 2.3 | `feat(examples): drive ReasoningBridge with a Mastra agent via fromMastraAgent` — wire a Mastra-backed `new ReasoningBridge(fromMastraAgent(agent))` into the worker/example (explicit adapter, no auto-wrap — B3). | `pnpm -r typecheck && pnpm -r test`; edge bundle still clean (Mastra adapter must not pull Node-only deps; gate if it does). |
| 2.4 | `test(edge): live worker turn through a Mastra-backed bridge` (opt-in, deployed). | `SYRINX_LIVE_WORKER_TEST=1 ...`; deployed turn with a Mastra agent. |

### Step 3 — `suspended` / `runId` DO path

| # | Commit | Acceptance / proof |
|---|---|---|
| 3.1 | `feat(voice): reasoning.suspended + reasoning.resume packets` — add to the packet union + factories; `ReasonerTurn.resume` already exists from 1.1. | `pnpm --filter @asyncdot/voice typecheck`; packet tests. |
| 3.2 | `feat(bridge-mastra): emit suspended part + resume re-entry` — adapter maps `tool-call-suspended`→`suspended` (terminal) and routes `turn.resume` to `agent.resumeStream(data,{runId})`. | `pnpm --filter @asyncdot/voice-bridge-mastra test` (scripted suspend→resume). |
| 3.3 | `feat(bridge): persist suspended runId, resume on next turn + spoken-prefix reconciliation` — bridge handles the `suspended` part: speak `prompt`, emit `reasoning.suspended`, persist `{runId,contextId,payload}` via an injected `RunStore`; on a turn with a pending run, build a `resume` turn. **(B4)** Implement `onResumeConflict: "restart" \| "replay"` (default `restart`): if a spoken-prefix correction landed since suspend, discard + re-ask instead of `resumeStream`. Barge-in on a suspended run discards it. | bridge unit tests with a fake `RunStore`: suspend→resume (clean), **suspend→barge-in→resume → `restart` (no stale checkpoint)**, barge-in-discards. |
| 3.4 | `feat(voice-server-workers): DurableObjectRunStore on ctx.storage.sql` — one `reasoning_runs` table, mirrors `DurableObjectSessionStore`; wire into the DO; alarm-GC stale rows (TTL). | `pnpm --filter @asyncdot/voice-server-workers test`. |
| 3.5 | `test(edge): suspend → hibernate → resume across two voice turns (workerd)` — Miniflare test asserting the run resumes after the DO is evicted between turns. | `pnpm --filter @asyncdot/voice-server-workers test` (the new DO suspend/resume test). |

**Rollback:** every step-1 commit is behavior-preserving, so any can be reverted independently; steps 2–3 are additive (new package / opt-in path) and revert without touching the AI SDK path.

---

## 9. Risks & open questions

- **Mastra wire shapes** (`tool-call-suspended` payload, `resumeStream` signature, `processDataStream` chunk fields) are taken from current docs, not a running build — confirm against the pinned `@mastra/core` version at step 2.1 before finalizing the mapping. (AI SDK v6 `TextStreamPart` union is verified against `ai@6.0.191`, incl. the `error`/`tool-error`/`finish-step`/`abort` members B1 maps; `ToolLoopAgent.stream()` returns a `Promise<StreamTextResult>`, so adapters `await` it — B3.)
- **Edge-bundle weight (Mastra):** `@mastra/core` may pull heavier deps; step 2.3 must keep `verify-edge-bundle.sh` green or gate Mastra to the Node build with a runtime-split export (mirror the `voice-ws` `./node` pattern).
- **History on Mastra resume runs vs the spoken-prefix correction (B4):** the suspended run holds its own checkpoint, which `resumeStream` restores *uncorrected* — so a barge-in that landed between suspend and resume diverges from the bridge's corrected history. Resolved by the `onResumeConflict: "restart" | "replay"` policy in §4.6 (default `restart`), **not** by the earlier "dual-sourced, acceptable" hand-wave. Only materializes when barge-in and suspend/resume overlap.
- **Who converts "next user turn" → `resume.data`?** The orchestrator (turn-routing owner), not the adapter — keeps the bridge a pure function of the turn. Confirm the mapping policy (raw text vs structured) per workflow at step 3.3.
- **Multi-agent / workflows / sub-agents** need no special handling: they flatten into one `agent.stream().fullStream`; nested agents/workflows surface as ordinary `tool-call`/`tool-result` parts, only the responding agent's `text-delta` is spoken. The sole composite-specific primitive is `suspended` (step 3).
- **Realtime / S2S** is out of scope; when added it is a sibling `VoicePlugin`, and a `Reasoner` plugs into it as a delegate tool — no change to this seam.
