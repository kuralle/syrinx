# Understanding — suspend/resume DO path (Sprint 3)

> Author: claude-opus-4-8[1m] · manager · 2026-06-05. Grounded in `voice-server-workers/src/{worker,durable-session-store,alarm-scheduler}.ts`, `voice-bridge-aisdk/src/index.ts` (`ReasoningBridge`), `voice-bridge-mastra/src/from-mastra.ts`, `voice/src/reasoner.ts`. Confidence: high.

## Primitive (one line)

A **suspended run** is a Mastra checkpoint parked by `runId`: the bridge speaks the agent's question, persists `{runId, contextId, payload}` in the DO (surviving hibernation), ends the turn; the next user turn becomes a `resume` that re-enters Mastra via `resumeStream(data, {runId})` — **unless** a spoken-prefix correction landed since suspend, in which case the run is discarded and re-asked (B4).

## The four layers (already half-built)

- **Seam (`voice/src/reasoner.ts`)** — `ReasoningPart.suspended {runId, toolId?, prompt?, payload}` + `ReasonerTurn.resume {runId, data}` **already exist** (S0-01). S3-01 only adds the bus **packets** `reasoning.suspended`/`reasoning.resume` + factories.
- **Mastra adapter (`from-mastra.ts`)** — the `// Sprint 3 (S3-02)` marker: map `tool-call-suspended` (`payload.suspendPayload`, `out.runId`) → terminal `{type:"suspended", runId, prompt?, payload}`; and when `turn.resume` is set, call `agent.resumeStream(turn.resume.data, {runId: turn.resume.runId})` instead of `agent.stream(messages, …)`, then map its `fullStream` identically.
- **Bridge (`ReasoningBridge`)** — S3-03 adds: a `suspended` case in the 6-case switch (speak `prompt`, emit `reasoning.suspended`, `runStore.save`, end turn — no `llm.done`); pending-run detection at turn start (`runStore.takePending(contextId)` → build `ReasonerTurn.resume`); the **(B4) `onResumeConflict`** policy; barge-in discards a suspended run.
- **DO (`worker.ts`)** — S3-04 adds `DurableObjectRunStore` (SQL on `ctx.storage.sql`, mirrors `DurableObjectSessionStore`), constructed in `VoiceConversation` and **threaded** into `createLiveVoiceAgentSession` → the `ReasoningBridge` constructor.

## Verified patterns to mirror

- **`DurableObjectSessionStore`** (`durable-session-store.ts`): `constructor(storage: {sql}, scheduler)`; `CREATE TABLE IF NOT EXISTS` in ctor; `storage.sql.exec(query, ...bindings)` returns an iterable of rows; `INSERT OR REPLACE`, `SELECT * WHERE id = ?`, `DELETE WHERE id = ?`. The `[row] = [...exec(...)]` idiom reads one row.
- **`DurableObjectAlarmScheduler`** (`alarm-scheduler.ts`): `schedule(key, delayMs, cb)`, `cancel(key)`, `runDue()` (called from the DO `alarm()`). TTL-GC for stale runs uses `scheduler.schedule(\`run.ttl:${runId}\`, ttlMs, () => store.discard(runId))`.
- **Hibernation:** the DO uses `ctx.acceptWebSocket`; in-memory maps are lost on eviction, **SQL persists**. So the run row MUST live in SQL (not an in-memory Map) to survive a turn-to-turn eviction — that is the whole point of S3-04's workerd test.

## The `RunStore` seam (S3-03 defines, S3-04 implements)

```ts
// injected into ReasoningBridge; bridge-agnostic so unit tests use a fake.
export interface RunStore {
  save(run: { runId: string; contextId: string; payload: unknown }): Promise<void> | void;
  takePending(contextId: string): Promise<PendingRun | null> | PendingRun | null;  // returns + (optionally) leaves the row for the bridge to discard/resume
  discard(contextId: string): Promise<void> | void;  // barge-in / restart / after-resume cleanup
}
export interface PendingRun { runId: string; payload: unknown }
```
- `ReasoningBridge` constructor gains an optional `runStore?: RunStore` + an `onResumeConflict?: "restart" | "replay"` (default `"restart"`). No `runStore` → suspend/resume is inert (a `suspended` part with no store is an error/no-op — AI SDK path never emits one).
- **Resume-data mapping (RFC §9 open q):** the bridge maps the next user turn's `userText` → `resume.data` (raw text) by default — the orchestrator owns richer mapping; Sprint 3 uses raw text.

## (B4) Spoken-prefix reconciliation — the subtle correctness issue

`resumeStream(data,{runId})` restores Mastra's **uncorrected** checkpoint. If a barge-in rewrote the bridge's history (spoken prefix) on a turn within the suspended run's context since it suspended, resuming would diverge from corrected history. **Default `restart`:** on a pending run, if `commitInterruptedHistory` fired for that context since the suspend, **discard** the run + re-issue the question as a fresh `agent.stream(corrected messages)` turn (no `resumeStream`). `replay` (opt-in) passes corrected `messages` alongside `resumeData`. Tests (S3-03, fake RunStore): clean suspend→resume; suspend→barge-in→resume → `restart`; barge-in-on-suspended → discard.

## Invariants

- **No latency on non-suspending turns** (§7a): the pending-run check is one `takePending(contextId)` (a SQL `SELECT` — local, microseconds) at turn start; it must not add an I/O hop to the hot path. Gate: short-fixture LLM-TTFT within the S1-00 band.
- **Edge stays Mastra-free:** `DurableObjectRunStore` is edge code (SQL); the Mastra `resumeStream` runs on the Node path. `@mastra/core` must not enter the worker bundle (`verify-edge-bundle.sh`).
- **Suspended part is terminal** (like `error`/`finish`): the adapter `return`s after it.

## Coupling hotspots

- **Threading the RunStore** DO → `createLiveVoiceAgentSession` → `ReasoningBridge`: `createLiveVoiceAgentSession`'s signature gains an optional `runStore`. The Node path (examples) can inject an in-memory `RunStore`; the DO injects `DurableObjectRunStore`.
- **`takePending` vs barge-in ordering:** the pending-run check at turn start must run BEFORE the new turn supersedes/aborts; the B4 check reads whether a correction landed (a per-context flag the bridge already has via `commitInterruptedHistory`).

## Open questions

- **OQ-S3-1:** does the workerd/Miniflare test harness (S3-04) exercise true hibernation (DO eviction between two `fetch`/turn calls), or simulate it by constructing a fresh store over the same SQL? The RFC wants "DO evicted between turns" — Miniflare's `getDurableObjectStorage`/new-instance-over-same-storage is the realistic proxy. Confirm at S3-04.
- **OQ-S3-2:** resume-data shape — raw `userText` (default) vs structured. Sprint 3 = raw text; revisit per workflow.

## Suggested next command

implement → S3-01 (packets) → S3-02 (Mastra suspend/resume) → S3-03 (bridge + RunStore seam + B4) → S3-04 (DurableObjectRunStore + workerd hibernation test). Link this artifact in each brief.
