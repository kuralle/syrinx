# Sprint 3 — Warm-down

> **Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05.
> **Sprint window:** 2026-06-05 (closed same day).
> **Outcome:** Goal achieved + exceeded. A Mastra workflow `suspend()` parks a run persisted by `runId` in the DO, is asked of the user, and resumes on a later turn surviving hibernation — proven in workerd (two-turn test) **and** on the live deployed edge with a real model.

---

## 1. Goal recap

**Sprint goal (WBS):** a Mastra workflow `suspend()` parks a run persisted by `runId` in the DO, asked of the user, resumed on a later voice turn, surviving DO hibernation between turns (proven in workerd).

**Did we hit it?** **Yes**, and added a live-deployed proof. The path is proven twice: the local workerd two-turn test (the WBS demo) and a real-`gpt-4.1-mini` deployed turn. Critically, **research corrected the architecture before implementation** — the original RFC §4.6 ("one `{runId,contextId,payload}` row") couldn't work; Mastra owns the snapshot.

---

## 2. Stories shipped

| Story | Status | Commit(s) | Notes |
|-------|--------|-----------|-------|
| (pivot) | — | `c7ca76d` | Research + spike → RFC v2.3 (Mastra-on-edge-DO + `CloudflareDOStorage` + pointer RunStore); `spike-reference/` preserved. |
| S3-01 | Done | `ab75d6f` | `reasoning.suspended`/`reasoning.resume` packets + factories. |
| S3-02 | Done | `f75585f` | Mastra adapter: `tool-call-suspended`→`suspended`; `turn.resume`→`resumeStream`. |
| S3-03 | Done | `d753399` + `162629f` (mgr fix) | Bridge: pointer `RunStore` + `suspended` handling + (B4) `onResumeConflict` (`restart`; `replay` throws). |
| S3-04 | Done | `ecaebd0` + `ef65d33` (real model) | Dedicated Mastra-on-edge worker + `CloudflareDOStorage` + SQL pointer `RunStore` + workerd two-turn test; **deployed** (Version `40a15353`, Paid tier). |

---

## 3. What's working

- Suspend/resume across hibernation: workerd two-turn test 3/3 (`SYRINX_MASTRA_EDGE_TEST=1`) + live deployed turn (`voice-server-workers-mastra.mithushancj.workers.dev`).
- Mastra snapshot in `CloudflareDOStorage` (`mastra_workflow_snapshot`) + our `{contextId→runId}` pointer (`reasoning_run_pointers`) both in DO SQLite; resume on a fresh instance by `runId`.
- The AI-SDK product worker stays Mastra-free + edge-clean; `Reasoner`/`ReasoningPart`/`ReasoningBridge` surfaces unchanged.
- 188 (voice) + 23 (bridge-aisdk) + 9 (bridge-mastra) tests pass; `pnpm -r typecheck` green.

---

## 4. What's not working / known issues

| ID | Description | Severity | Tracking |
|----|-------------|----------|----------|
| KI-3-01 | `pnpm -r test` flakes under concurrency (`voice-server-websocket` smartpbx/send_after_close; `voice-stt-google` Smart-Turn-EOS — 5 s-timeout tests, pass in isolation, untouched by S3). | minor | backlog: raise timeouts / fake timers / serialize |
| KI-3-02 | Mastra worker is 8 MB → **Workers Paid tier**; bundle diet to reach Free tier not done. | minor | backlog (RFC §9) |
| KI-3-03 | Live-deploy demo's resume reply re-asks for confirmation (real-LLM phrasing), not a clean "deployed". Mechanism is correct. | nit | backlog: tune agent instructions/tool |
| KI-3-04 | `replay` `onResumeConflict` mode throws "not yet supported" (needs Mastra injected-history-on-resume, unverified). | nit | backlog (B4 replay) |
| KI-3-05 | `alarm-scheduler.ts` duplicated in the new worker package. | nit | backlog: extract shared package |

---

## 5. Decisions made

- **Decision (RFC v2.3):** cross-turn resume needs Mastra's own durable snapshot store → **dedicated Mastra-on-edge worker DO** with `CloudflareDOStorage(ctx.storage.sql)` (`nodejs_compat`, Paid tier); our `RunStore` is a `{contextId→runId}` pointer. **Rationale:** spike-verified (`AGENT_RESUME_NO_SNAPSHOT_FOUND` with in-memory store; `@mastra/core` needs `nodejs_compat`; 7.8 MB). **Source:** `spike-reference/VERDICT.md`, research (Cloudflare Agents SDK / Mastra docs). **Amendment:** RFC §4.6 + §9 v2.3. **User-confirmed:** Option A + Paid tier + deploy.
- **Decision:** (B4) default `restart` via barge-in-discards-pointer; `replay` throws (unverified). **Source:** RFC §4.6.

---

## 6. Wiki / RFC amendments this sprint

RFC v2.3 — §4.6 rewritten (Mastra-on-edge-DO + `CloudflareDOStorage` + pointer RunStore), §9 edge-weight quantified, changelog (commit `c7ca76d`). Public seam surfaces unchanged.

---

## 7. Metrics

- **Diff:** +1138 / −17 (new `voice-server-workers-mastra` package + packets + adapter + bridge suspend/resume).
- **Tests:** +5 bridge suspend/resume, +2 Mastra suspend/resume, +2 packet factories, +3 workerd (gated).
- **Deploy:** `voice-server-workers-mastra` Version `40a15353`, 8.0 MB / 1.4 MB gz, startup 249 ms (Paid tier).
- **Credits:** spike used a stub model (0); the live deploy demo used ~2 real `gpt-4.1-mini` turns.

---

## 8. Backlog updates

**Added:** KI-3-01 (test flakiness), KI-3-02 (bundle diet), KI-3-03 (demo prompt), KI-3-04 (replay mode), KI-3-05 (shared alarm-scheduler). Existing B-03 (`@mastra/ai-sdk` path) open.

---

## 9. Retrospective

### Keep
Front-loading uncertainty with research + a throwaway spike *before* committing the sprint design — it caught a fundamental RFC flaw (Mastra owns the snapshot) and the edge-bundle reality (nodejs_compat, Paid tier) before a line of production code, then the spike became the S3-04 template. Surfacing the architecture forks to the user at each decision (Option A/B/C, Paid tier, deploy) kept a high-stakes pivot aligned.

### Change
My S3-02 proceed check didn't run `pnpm -r typecheck` after changing a shared exported type (`MastraAgentLike`), so a cross-package break slipped to S3-03. **Always `pnpm -r typecheck` in proceed when a story touches a shared/exported type.**

### Try next
Sprint 4 is polish/release — run the cross-backend latency report on the **short fixture** (credit-saving) and write the package READMEs from the shipped APIs; the trunk PR is the capstone. No new external dependencies expected.

---

## 10. Pointers for the next sprint (Sprint 4 — Polish + 1.0)

- **Goal (WBS):** latency report across both backends within budget, docs current, every RFC risk resolved/backlogged, final live demo through AI SDK + Mastra + suspend/resume.
- **Files:** `docs/latency-budget.md` (append the cross-backend report — short fixture, `SYRINX_WS_MAX_TURNS=1`); package READMEs for `@asyncdot/voice` (Reasoner seam), `voice-bridge-aisdk`, `voice-bridge-mastra`, `voice-server-workers-mastra`; `docs/rfc-reasoner-bridge.md` §9 risk closeout; the WBS §4 backlog.
- **Demo:** AI-SDK live turn (Sprint 1, Version `cc9236aa`) + Mastra live turn (Sprint 2, Node) + suspend/resume (Sprint 3, deployed `40a15353`) — all already proven; Sprint 4 assembles them into one report + the trunk PR.
- **Traps:** KI-3-01 (run package tests in isolation, not `pnpm -r test`, when judging green); latency gate stays the short fixture vs the S1-00 band.
- **Final step:** merge `v2` → trunk via PR (the program's capstone). Confirm with the user before opening/merging.

---

## 11. Closeout

- [x] Sprint-3 commits on `v2` (pivot + 4 stories + fix + real-model + deploy).
- [x] Phase B review — Approve (`review-sprint.md`); m1 fixed (`162629f`).
- [x] Deployed (user-authorized, Paid tier) — live suspend/resume proven.
- [x] `sprints/sprint-3/HANDOFF.md` written; `sprints/STATE.md` → Sprint 4.
- [x] Backlog deltas (KI-3-01..05) noted.

Sprint 3 is closed.
