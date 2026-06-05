# Sprint 3 — Plan

**Sprint name:** Suspend / resume DO path
**Sprint goal (one sentence):** A Mastra workflow `suspend()` parks a run that is persisted by `runId` in the Durable Object, asked of the user, and resumed on a later voice turn — surviving DO hibernation between turns (proven in workerd).
**Sprint window:** 2026-06-05 → 2026-06-12
**Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05

**Read first:** `.understanding/suspend-resume-do.md` (the map), `sprints/sprint-3/spike-reference/VERDICT.md` (the Mastra-on-edge feasibility proof), RFC §4.6 (v2.3, amended this sprint).

> **⚠️ v2.3 architecture pivot (after research + the `mastra-edge` spike):** cross-turn `resumeStream(runId)` needs **Mastra's own durable snapshot store**, not a hand-rolled run-state row. **Adopted (user-confirmed): Mastra on a dedicated Cloudflare Worker DO** with `@mastra/cloudflare` `CloudflareDOStorage({ sql: ctx.storage.sql })` (`nodejs_compat`, wrangler-bundled ~7.8 MB → **Workers Paid tier**). The main AI-SDK product worker stays Mastra-free + `verify-edge-bundle.sh`-clean. Our `RunStore` shrinks to a `{contextId → pending runId}` **pointer** (Mastra owns the checkpoint). S3-04 below is rewritten accordingly; S3-02/S3-03 are largely unchanged (the spike confirmed the adapter + bridge shapes). Spike proof: `spike-reference/` (FEASIBLE-WITH-CAVEATS, 2/2 workerd tests pass).

---

## 1. Stories (WBS §Sprint 3 — order strict; S3-04 depends on S3-03 depends on S3-02 depends on S3-01)

### `S3-01` — `reasoning.suspended` + `reasoning.resume` packets + factories (`@asyncdot/voice`)

**Description:** Add the two bus packets to `packets.ts` (the `VoicePacket` union) + factories to `packet-factories.ts`. `ReasonerTurn.resume` + `ReasoningPart.suspended` already exist (S0-01) — this is the **bus** vocabulary the bridge emits/consumes.

**Acceptance criteria:**
1. `ReasoningSuspendedPacket` (`kind:"reasoning.suspended"`, `{contextId, timestampMs, runId, prompt?, payload}`) + `ReasoningResumePacket` (`kind:"reasoning.resume"`, `{contextId, timestampMs, runId, data}`) added to the packet union + exported from `voice/src/index.ts`.
2. Factories `reasoningSuspended(...)` / `reasoningResume(...)` in `packet-factories.ts`, mirroring existing factory style.
3. `pnpm --filter @asyncdot/voice typecheck` + `test` green; packet-factory tests (happy path per factory).

**Files:** `voice/src/packets.ts`, `voice/src/packet-factories.ts`, `voice/src/index.ts`, a packet-factory test. Commit `[S3-01] reasoning.suspended + reasoning.resume packets + factories`.

### `S3-02` — Mastra adapter: emit `suspended` + resume re-entry

**Description:** Fill the `// Sprint 3` marker in `from-mastra.ts`: map `tool-call-suspended` → terminal `{type:"suspended", runId: out.runId, toolId?, prompt?, payload: chunk.payload.suspendPayload}`; and when `turn.resume` is set, call `agent.resumeStream(turn.resume.data, {runId: turn.resume.runId})` instead of `agent.stream(messages, …)`, mapping its `fullStream` with the same generator.

**Acceptance criteria:**
1. `tool-call-suspended` → terminal `suspended` part (verified shape: `payload.suspendPayload`, `out.runId`); `prompt` from the suspend payload if present.
2. `turn.resume` routes to `resumeStream(data, {runId})`; absent → normal `stream(messages)`. `MastraAgentLike` gains `resumeStream(data, opts:{runId; toolCallId?}) → Promise<{runId; fullStream}>`.
3. `pnpm --filter @asyncdot/voice-bridge-mastra test` green incl. a **scripted suspend→resume** sequence (no network): stream 1 ends with `tool-call-suspended` → `suspended`; a `turn.resume` drives `resumeStream` → text + `finish`.

**Files:** `from-mastra.ts`, `from-mastra.test.ts`. Commit `[S3-02] Mastra adapter: suspended part + resumeStream re-entry`.

### `S3-03` — Bridge handles `suspended`: persist via `RunStore` + resume + (B4) reconciliation

**Description:** Add to `ReasoningBridge`: a `RunStore` seam (injected, optional) + `onResumeConflict: "restart" | "replay"` (default `restart`). Handle the `suspended` part (speak `prompt`, emit `reasoning.suspended`, `runStore.save({runId, contextId, payload})`, end turn — no `llm.done`). At turn start, `runStore.takePending(contextId)` → build `ReasonerTurn.resume = {runId, data: userText}` (raw text mapping). **(B4):** if a spoken-prefix correction landed for that context since suspend, `restart` (discard + re-ask with corrected `messages`, no `resumeStream`). Barge-in on a suspended run discards it.

**Acceptance criteria:**
1. `RunStore` interface + `PendingRun` (per `.understanding`); `ReasoningBridge` constructor accepts `{ runStore?, onResumeConflict? }` (or a second arg) — **backward-compatible** (no runStore → suspend/resume inert; the existing 9 + Mastra tests unchanged).
2. `suspended` case: speak `prompt` (emit a `tts.text`/`llm.delta` as appropriate + `reasoning.suspended` packet), `runStore.save`, terminal (no `llm.done`).
3. Pending-run resume: a turn with a pending run for its context builds `turn.resume`; clean resume clears the row after a successful `finish`.
4. **(B4)** default `restart`: `suspend→barge-in→resume` discards + re-asks (no stale checkpoint); barge-in on a suspended run discards the row.
5. Bridge unit tests with a **fake `RunStore`**: clean suspend→resume; suspend→barge-in→resume→`restart`; barge-in-discards. The existing 9 `index.test.ts` + 18 adapter tests stay green (assertions unchanged).
6. `pnpm --filter @asyncdot/voice-bridge-aisdk test` green; **latency unchanged** (the `takePending` check is one local SQL `SELECT`; non-suspending turns add ~0 — manager gate, short fixture).

**Files:** `voice-bridge-aisdk/src/index.ts` (+ the `RunStore` type — likely exported there or from `@asyncdot/voice`), `index.test.ts` (new suspend tests, existing unchanged). Commit `[S3-03] bridge: persist suspended runId + resume + (B4) onResumeConflict`.

### `S3-04` — Dedicated Mastra-on-edge worker (CloudflareDOStorage) + `{contextId→runId}` pointer + workerd two-turn test

**Description (v2.3 — rewritten):** Build a **dedicated** Mastra Cloudflare Worker DO (a new package, e.g. `@asyncdot/voice-server-workers-mastra`, or an `examples/` deployable — formalize the `sprints/sprint-3/spike-reference/` prototype). It runs `new Mastra({ storage: new CloudflareDOStorage({ sql: ctx.storage.sql }), agents })` so Mastra persists its workflow snapshot in the DO's SQLite (cross-turn resume + hibernation survival come from Mastra's store). Wire `new ReasoningBridge(fromMastraAgent(agent))` with an injected **pointer** `RunStore` (a `reasoning_run_pointers(context_id PK, run_id, created_at_ms)` table on the same `ctx.storage.sql`) — the bridge records "conversation X awaits run Y"; the actual checkpoint is Mastra's. `nodejs_compat` + wrangler bundling; **Workers Paid tier**.

**Acceptance criteria:**
1. Dedicated Mastra worker bundles via **wrangler** (`nodejs_compat`, `compatibility_date ≥ 2026-06-01`); `Mastra` + `CloudflareDOStorage(ctx.storage.sql)` boot in workerd (proven by the spike — formalize it). The Mastra agent uses **no `fs`/workspace tools** (Workers has no filesystem).
2. `RunStore` (pointer) implemented over `storage.sql` (`{context_id → run_id}`); TTL-GC via the alarm scheduler; injected into `ReasoningBridge` (S3-03 seam).
3. **The main AI-SDK product worker (`packages/voice-server-workers`) is untouched + stays `verify-edge-bundle.sh`-clean** — `@mastra/core` is **only** in the new Mastra worker package.
4. A **workerd/Miniflare two-turn test** (mirror `spike-reference/spike.test.ts`): turn 1 suspends (`tool-call-suspended` → `reasoning.suspended` + pointer saved); a **fresh Mastra instance over the same `ctx.storage.sql`** (hibernation proxy); turn 2 resumes by `runId` → completes. Asserts the snapshot + pointer survive.
5. `pnpm -r typecheck && pnpm -r test` green (the Mastra worker's wrangler-based test gated behind an opt-in flag so it doesn't slow the default suite — mirror `SYRINX_LIVE_WORKER_TEST`); `verify-edge-bundle.sh` (product worker) clean.

**Files:** new `packages/voice-server-workers-mastra/` (worker + `CloudflareDOStorage` wiring + pointer `RunStore` + `wrangler.toml` nodejs_compat + workerd test), built from `sprints/sprint-3/spike-reference/`. **Deploy is outward-facing + needs Paid tier — surface to the user first.** Commit `[S3-04] dedicated Mastra-on-edge worker + CloudflareDOStorage + pointer RunStore + workerd two-turn test`.

**Note:** the heavy `@mastra/core` (7.8 MB) lives only in this worker; a bundle-diet to reach Free tier is backlog (RFC §9).

---

## 2. Universal DoD (per story)

- [ ] `pnpm --filter <pkg> typecheck`/`test` green (workspace-wide at S3-04).
- [ ] Behavioral coverage incl. the failure/edge paths (suspend, resume, barge-in-discard, B4 restart).
- [ ] **Edge gate (S3-04):** `verify-edge-bundle.sh` clean (`@mastra/core` not in the worker).
- [ ] **Latency gate (S3-03/S3-04):** non-suspending-turn LLM-TTFT within the S1-00 band (short fixture).
- [ ] Proof JSON (`"schema_version":1`) + manager PROCEED.
- [ ] No `--no-verify`/`@ts-ignore`/silent-catch.
- [ ] Atomic commit `[S3-{nn}]` on `v2`.

---

## 3. Test plan

| Story | Layer | Test |
|-------|-------|------|
| S3-01 | unit | packet factories (happy path each) |
| S3-02 | unit | scripted suspend→resume (no network) |
| S3-03 | unit | fake `RunStore`: clean suspend→resume, suspend→barge-in→resume→restart, barge-in-discard; existing tests unchanged |
| S3-04 | workerd | suspend → DO evicted → resume across two turns (Miniflare); edge clean |

---

## 4. Demo plan

**Demo:** a Miniflare two-turn run — suspend on turn 1, DO evicted, resume on turn 2 by `runId`, asserted end-to-end (the WBS Sprint-3 demo).

---

## 5. Risks specific to this sprint

| Risk | Detection | Mitigation |
|------|-----------|------------|
| **(B4)** stale checkpoint overwrites corrected history | the `suspend→barge-in→resume` test | `onResumeConflict` default `restart` (discard + re-ask) |
| run row doesn't survive hibernation | the workerd two-turn test | persist in SQL (not in-memory Map); mirror the session store |
| `@mastra/core` leaks into the worker via the RunStore wiring | `verify-edge-bundle.sh` | RunStore is pure SQL (edge); Mastra `resumeStream` runs Node-side; never import `@mastra/core` in the worker |
| suspend adds latency to non-suspending turns | short-fixture gate vs S1-00 | `takePending` is one local SQL `SELECT`; no I/O hop on the hot path |
| `ReasoningBridge` constructor change breaks existing call sites | `pnpm -r typecheck && test` | make `runStore`/`onResumeConflict` optional + backward-compatible |

---

## 6. Open questions

- **OQ-S3-1** (`.understanding`): does S3-04's Miniflare test exercise true DO eviction or a fresh-store-over-same-SQL proxy? Confirm at S3-04 (the realistic proxy is acceptable if true eviction isn't scriptable).
- **OQ-S3-2:** resume-data shape — raw `userText` (Sprint 3 default) vs structured. Revisit per workflow.
- **Demo workflow:** S3-04's test needs a Mastra agent/workflow that actually suspends (`suspend()` in a tool/workflow step). Scripted in the Mastra adapter test (S3-02); the workerd test (S3-04) may use a minimal real suspending Mastra workflow OR a scripted adapter — confirm at S3-04 (prefer a minimal real suspend to prove the end-to-end runId path).
