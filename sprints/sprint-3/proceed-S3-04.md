# Proceed Evidence — `S3-04` dedicated Mastra-on-edge worker + CloudflareDOStorage + pointer RunStore + workerd two-turn test

> **Manager artifact — Phase A.** Closes Phase A for Sprint 3.

- **Id:** `S3-04` · **Commit:** `ecaebd0` · **IC slug:** `s3-04`

## Checklist (manager — read diff + ran tests)

- [x] `verify-handoff-proof.sh s3-04` → `PROOF_OK` (5 claims, 6 assertions).
- [x] New package `packages/voice-server-workers-mastra/` (worker.ts DO, durable-run-store.ts, alarm-scheduler.ts, mock-model.ts, worker.test.ts, wrangler.toml nodejs_compat). Scope: new package + lockfile only.
- [x] **Product worker Mastra-free** (`grep -rn "@mastra" packages/voice-server-workers/src` → none); **`verify-edge-bundle.sh` clean** (the AI-SDK product worker invariant holds).
- [x] `DurableObjectRunStore` implements the S3-03 `RunStore` (imports `RunPointer`/`RunStore` from `@asyncdot/voice-bridge-aisdk`) over `ctx.storage.sql` — `reasoning_run_pointers(context_id PK, run_id, created_at_ms)`, `INSERT OR REPLACE`/`SELECT`/`DELETE`, **pointer-only** (Mastra owns the snapshot), TTL-GC via `scheduler.schedule(\`run.ttl:${contextId}\`, …)`. Mirrors `DurableObjectSessionStore`.
- [x] DO wires `new Mastra({ storage: CloudflareDOStorage({sql: ctx.storage.sql}), agents })` + `new ReasoningBridge(fromMastraAgent(agent), { runStore: DurableObjectRunStore, onResumeConflict: "restart" })` (nodejs_compat). Stub model for the test (no network).
- [x] Heavy workerd test gated behind `SYRINX_MASTRA_EDGE_TEST=1` — default `pnpm -r test` unaffected (no added flakiness; KI-3-01).
- [x] No `@ts-ignore`/suppression; no edits outside the new package.

**Independent verification:**
- `pnpm -r typecheck` → exit 0.
- **`SYRINX_MASTRA_EDGE_TEST=1 pnpm --filter @asyncdot/voice-server-workers-mastra test` → 3/3 PASS:** *"suspend → fresh DO/same SQL → resume via ReasoningBridge + pointer RunStore"* on real `wrangler unstable_dev` (workerd) — `/suspend` 200 → fresh instance over same `ctx.storage.sql` → `/resume` 200; pointer saved then discarded; Mastra snapshot resumed by `runId`.
- `verify-edge-bundle.sh` (product worker) clean.

**Verdict:** `PROCEED` — Phase A complete (S3-01…S3-04 all PROCEED).

## Notes — the WBS Sprint-3 demo is MET locally

The WBS Sprint-3 demo is "a Miniflare two-turn run — suspend on turn 1, DO evicted, resume on turn 2 by `runId`, asserted end-to-end." **That is exactly the passing workerd two-turn test** (fresh DO over the same SQL is the hibernation proxy; same SQL persistence is the critical invariant — VERDICT.md Q3). So the **Sprint-3 goal is proven** without a deploy.

- A **production deploy** of the Mastra worker (Paid tier, real OpenAI model) would be an *additional* live-deployed proof (like S1-03) — outward-facing + a billing action. Surfaced to the user separately; not required for the WBS goal.
- The IC duplicated `alarm-scheduler.ts` into the new package (self-contained) rather than importing from `voice-server-workers` — acceptable for an independent worker; a shared-package extraction is backlog.
- Bundle diet to reach Workers Free tier remains backlog (RFC §9).

---

## Live-deployed proof (user-authorized, Paid tier)

Deployed `voice-server-workers-mastra` to Cloudflare (Version `40a15353`, startup 249 ms, 8.0 MB / 1.4 MB gz — Paid tier confirmed). `OPENAI_API_KEY` secret set; `/health` → ok. Real `gpt-4.1-mini` (commit `ef65d33` wires the real model when the key is present).

**Live deployed suspend → resume** (`https://voice-server-workers-mastra.mithushancj.workers.dev`, contextId `live-demo`):
- **Turn 1 `/suspend`:** real model called `confirmAction` (`llm.tool_call`) → suspended. `runId: 683801bd-70be-496e-bbc7-9fe20bfa07f6`; pointer saved; DO SQLite holds **`mastra_workflow_snapshot`** (Mastra's checkpoint) + **`reasoning_run_pointers`** (our pointer). Packets: `eos.turn_complete → llm.tool_call → llm.done → reasoning.suspended`.
- **Turn 2 `/resume`** (`{userText:"yes"}`): a **fresh Mastra instance** reloaded the snapshot from `CloudflareDOStorage` by `runId` → `resumeStream` re-entered (`llm.tool_result` → 20× `llm.delta` → `llm.done`); **pointer discarded** (`pointer: null`).

**Mechanism PROVEN on the deployed edge:** suspend → persist in DO SQL → fresh instance → resume by `runId` → complete → pointer cleared. Honest caveat: the resume *reply* re-asked for confirmation rather than declaring "deployed" — real-LLM/prompt-workflow phrasing, **not** a mechanism defect (the run genuinely resumed via the persisted snapshot); a crisper demo would tune the agent instructions (backlog).
