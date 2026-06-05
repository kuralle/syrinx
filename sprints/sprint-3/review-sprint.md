# Review (r1, sandwich) — Sprint 3 (Suspend/resume DO path): `S3-01`…`S3-04`

> **Reviewer (main session):** claude-opus-4-8[1m] · manager · 2026-06-05.
> **Diff under review:** `v2`, commits `ab75d6f` · `c7ca76d` (pivot+RFC v2.3) · `f75585f` · `d753399`+`162629f` · `ecaebd0`+`ef65d33`. `git diff 5130f63..HEAD` (17 files, +1138/−17). New package `@asyncdot/voice-server-workers-mastra`.
> **Artifacts:** `PLAN.md`, `spike-reference/`, `proceed-S3-01..04.md`, `.understanding/suspend-resume-do.md`.

---

## 1. Strengths

- **The research pivot prevented a wrong build.** Before writing suspend/resume code, prior-art research (Mastra docs, Cloudflare Agents SDK, OpenAI/Temporal/LangGraph patterns) + the `mastra-edge` spike proved the original RFC §4.6 ("persist one `{runId,contextId,payload}` row") was insufficient — Mastra owns the workflow snapshot and `resumeStream(runId)` needs Mastra's *own* durable store (`AGENT_RESUME_NO_SNAPSHOT_FOUND` otherwise). The design was corrected (RFC v2.3) *before* implementation, not after. This is the §1/§11 discipline paying off.
- **Empirical feasibility, not assumption.** Raw esbuild proved `@mastra/core` can't bundle `--platform=browser` (needs `events`/`fs`/`path`/`crypto`); the spike proved it *does* run on workerd via wrangler+`nodejs_compat`, with a **real** suspend→resume across a fresh instance over the same `ctx.storage.sql`. The 7.8 MB→Paid-tier + `fs` caveats were surfaced as evidence (`spike-reference/VERDICT.md`), not hand-waved.
- **The architecture isolates the cost.** The 8 MB Mastra+`nodejs_compat` worker is a **dedicated** package; the AI-SDK product worker stays Mastra-free + `verify-edge-bundle.sh`-clean (verified: `grep @mastra packages/voice-server-workers/src` empty). The edge-clean invariant holds where it matters.
- **The seam composed without churn.** `ReasoningPart.suspended` + `ReasonerTurn.resume` (designed in S0-01) needed only: bus packets (S3-01), an adapter `tool-call-suspended`/`resumeStream` mapping (S3-02), and a bridge `suspended` case + pointer `RunStore` + B4 (S3-03). The existing 9 bridge + 9 adapter tests stayed green throughout — the suspend/resume feature is additive.
- **(B4) handled correctly + simply:** barge-in discards the pending pointer → next turn re-asks fresh (`restart` by construction); `replay` throws "not yet supported" rather than silently mis-behaving.
- **Proven end-to-end on the real edge:** a live deployed `gpt-4.1-mini` turn suspended (tool-call) and resumed by `runId` from `CloudflareDOStorage` on a fresh instance — `mastra_workflow_snapshot` + `reasoning_run_pointers` both in DO SQLite (`proceed-S3-04.md`).

## 2. Critique

### 2.1 Blockers — none. ### 2.2 Majors — none.

### 2.3 Minors

#### m1. My S3-02 verification gap (caught at S3-03, fixed)
- **Where:** `MastraAgentLike` gained a required `resumeStream` in S3-02, breaking the S2-02 example test's fake under `pnpm -r typecheck`; my S3-02 proceed check ran only the mastra-package typecheck.
- **Severity:** minor — caught at S3-03 (the IC honestly flagged it), fixed in `162629f`. **Process fix:** a story that changes a shared exported type must run `pnpm -r typecheck` in proceed.

#### m2. Deployed-demo resume reply phrasing
- **Where:** the live `/resume` reply re-asked for confirmation instead of "deployed."
- **Severity:** minor — the *mechanism* resumed correctly (tool-result + completion from the persisted snapshot); the phrasing is real-LLM/prompt-workflow behavior. **Fix:** tune the agent instructions/tool for a crisper demo (backlog).

### 2.4 Nits
- `alarm-scheduler.ts` duplicated into the new package (self-contained) rather than shared — acceptable for an independent worker; shared-package extraction is backlog.
- 8 MB worker → **Workers Paid tier**; a bundle diet (narrow `@mastra/core` entry) to reach Free tier is backlog (RFC §9).
- **KI-3-01:** `pnpm -r test` flakes under concurrency (`voice-server-websocket` smartpbx/send_after_close, `voice-stt-google` Smart-Turn-EOS — all 5 s-timeout tests, pass in isolation, untouched by Sprint 3). Pre-existing; backlog (raise timeouts / fake timers / serialize).

## 3. Cross-cutting concerns

- **Edge invariant:** product worker Mastra-free + clean (verified). Mastra weight quarantined to the dedicated worker.
- **Latency:** the `takePending` pointer check is one local SQL `SELECT` on non-suspending turns — no hot-path I/O hop (RFC §7a); suspend/resume is opt-in per the run.
- **Persistence correctness:** Mastra owns the snapshot (`CloudflareDOStorage`), we own the pointer — the split is clean and proven to survive a fresh instance (the hibernation invariant).
- **Type safety:** no `any`/`@ts-ignore` in source (the `as unknown as`/`as never` casts bridge concrete Mastra types to the structural `MastraAgentLike`/model types — acceptable, localized).
- **RFC fidelity:** v2.3 amendment matches the shipped design; `Reasoner`/`ReasoningPart`/`ReasoningBridge` public surfaces unchanged across the whole program.

## 4. Constructive close

This was the program's highest-risk sprint and it landed without a blocker — largely because the research+spike front-loaded the uncertainty and corrected the RFC before code. The suspend/resume DO path is proven both locally (workerd two-turn test) and on the deployed edge (real-model live turn). m1 (my verification gap) and m2 (demo phrasing) are minor and addressed/backlogged. No `[S3-fix]` beyond `162629f`. Proceed to warm-down and Sprint 4 (Polish + 1.0): latency report across backends, READMEs, risk/backlog closeout, and the trunk PR.

## 5. Verdict
- [x] **Approve with minor fixes.** No blockers/majors; m1 fixed (`162629f`); m2 + nits backlogged. Sprint 3 is Done.
