# Sprint 4 — Warm-down (PROGRAM COMPLETE)

> **Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05.
> **Outcome:** Goal achieved. The Reasoner-bridge generalization is **released on `v2`** — latency report consolidated, packages documented, every RFC risk closed/backlogged. **This is the final sprint; the WBS is complete.**

---

## 1. Goal recap

**Sprint goal (WBS):** the bridge generalization is released — latency report across both backends within budget, docs current, every RFC risk resolved/backlogged, final demo through AI SDK + Mastra + suspend/resume.

**Did we hit it?** **Yes**, scoped to `v2` (no trunk merge — user-directed). The three live demos were already proven across Sprints 1–3; S4 consolidated the evidence (latency report + RFC §9.1 closeout) and documented the four public packages. No live re-runs (credit-saving).

---

## 2. Stories shipped

| Story | Status | Commit | Notes |
|-------|--------|--------|-------|
| S4-01 | Done | `4cc51f9` | Cross-backend latency report → `docs/latency-budget.md` (seam is latency-neutral). |
| S4-02 | Done | `287c3e7` | READMEs for the 4 packages (manager-authored — the cursor IC hung, was killed). |
| S4-03 | Done | `ea24862` | RFC §9.1 risk closeout + WBS §4 backlog reconciliation + "1.0 status (on v2)". |

---

## 3. Program summary (Sprints 0–4, all on `v2`)

The cascading LLM bridge was generalized from "wraps the AI SDK" to "drives any streaming reasoning backend" behind one normalized `Reasoner` seam, with **zero pipeline-primitive change** and the public seam surface unchanged across v2.0→v2.3:

- **S0** — `Reasoner` + `ReasoningPart` seam + AI SDK adapters (no-buffering, unit-tested).
- **S1** — `ReasoningBridge` drives the seam; **deployed** (`syrinx-voice-server-workers`, Version `cc9236aa`); zero behavior change (9 tests' assertions unchanged); latency-neutral; `AISDKBridgePlugin` removed.
- **S2** — `fromMastraAgent`; live Mastra Node turn within band; product worker stays Mastra-free.
- **S3** — suspend/resume DO path; **dedicated Mastra-on-edge worker deployed** (`voice-server-workers-mastra`, Version `40a15353`, Paid tier); live `suspend→resume` by `runId` proven (research+spike corrected RFC §4.6 before implementation).
- **S4** — latency report, READMEs, risk closeout.

**Commits:** `[S{0..4}-*]` on `v2` from `0c77044` → `HEAD`. RFC at v2.3.

---

## 4. What's not working / open (all backlog, none blocking)

| ID | Item |
|----|------|
| KI-3-01 | `pnpm -r test` flakes under concurrency (`voice-server-websocket`, `voice-stt-google` 5 s-timeout tests; pass in isolation; pre-existing, not Reasoner-bridge). |
| B-05 | Mastra-edge worker bundle diet (~8 MB → Workers Free <3 MiB). |
| B-06 | `onResumeConflict: "replay"` (currently throws; needs verified Mastra injected-history-on-resume). |
| B-07 | `v2` → `main` trunk merge (deferred — kept on `v2` per user direction). |
| B-01/B-02/B-03 | Realtime/S2S; first-class multi-agent; `@mastra/ai-sdk` alt path. |

---

## 5. Decisions made
- **Released on `v2`, not merged to trunk** (user-directed, 2026-06-05) → B-07.
- S4 consolidates already-proven demos rather than re-running live (credit-saving).

## 6. RFC amendments
None this sprint (RFC §9.1 closeout is documentation of status, not a surface change). Program RFC is **v2.3**; public seam unchanged throughout.

## 7. Metrics
- Sprint 4 diff: docs-only (`latency-budget.md`, 4 READMEs, RFC §9.1, WBS §4). `pnpm -r typecheck` green.
- Program: 5 sprints, ~14 stories, 2 deployed Cloudflare workers, 3 backends behind one seam.

## 9. Retrospective
- **Keep:** evidence-grounded proceed/review at every story; front-loading uncertainty with research+spike (S3) before committing a design; surfacing consequential/outward decisions (deploys, Paid tier, dep shape) to the user.
- **Change:** delegate verification must run **workspace-wide** typecheck when a shared exported type changes (the S3-02 gap); watch delegated workers for hangs (S4-02 cursor stalled 22 min — kill + do-it-directly is cheaper than waiting).
- **Try next:** if the program resumes, the trunk PR (B-07) + the Mastra bundle diet (B-05) are the natural next steps.

## 11. Closeout
- [x] All Sprint-4 stories committed on `v2`.
- [x] Phase B review — Approve (`review-sprint.md`).
- [x] `sprints/STATE.md` marked **program complete** (WBS done).
- [x] Kept on `v2` (no trunk merge).

**Sprint 4 is closed. The Reasoner-bridge program (Sprints 0–4) is COMPLETE on `v2`.**
