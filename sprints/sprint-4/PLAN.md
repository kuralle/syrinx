# Sprint 4 — Plan

**Sprint name:** Polish + 1.0
**Sprint goal (one sentence):** The bridge generalization is released **on `v2`**: a latency report across both backends within budget, docs current, every RFC risk resolved or backlogged, and the three demos (AI SDK + Mastra + suspend/resume) consolidated.
**Sprint window:** 2026-06-05 → 2026-06-12
**Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05

> **Scope note (user-directed):** **keep it as `v2` — NO trunk PR / no merge to `main` this sprint.** The WBS S4 "tagged/merged via PR" capstone is **dropped**; the deliverable stays on the `v2` branch. The three-way live demo is **already proven this session** (AI-SDK deployed `cc9236aa`; Mastra Node S2 + edge deployed `40a15353`; suspend/resume deployed) — S4 *consolidates the evidence*, it does not re-run live demos (credit-saving).

---

## 1. Stories

### `S4-01` — Cross-backend latency report (manager-authored)

**Description:** Append a "Reasoner-bridge cross-backend latency report" to `docs/latency-budget.md`, consolidating the LLM-TTFT evidence already captured this program against the S1-00 baseline band (no new live runs — the numbers are from this session's proceed evidence; cite them). Conclusion: the seam is a transparent passthrough — no seam-attributable regression on any backend.

**Acceptance criteria:**
1. Report section in `docs/latency-budget.md` with: the S1-00 baseline (P50 3290 / P95 4044; gate P50 ≤ 3920 / P95 ≤ 4530), the post-re-home AI-SDK numbers (S1-01: P50 mean 2705 over 6 runs), the Mastra-path numbers (S2-02: 2967 / 884), all **within band**; plus the suspend-path note (the `takePending` pointer check adds no hot-path I/O; non-suspending turns unaffected).
2. States the methodology (short fixture `SYRINX_WS_MAX_TURNS=1`, live-OpenAI-noise caveat) + the verdict (seam adds ~0; ~350 ms literature stage budget is the LLM provider's, not the seam's).
3. Cites the proceed-evidence sources. Manager-authored; commit `[S4-01] cross-backend latency report`.

### `S4-02` — Package READMEs (IC)

**Description:** Author READMEs for the shipped public surfaces: `@asyncdot/voice` (the `Reasoner` seam + `ReasoningPart`), `@asyncdot/voice-bridge-aisdk` (`ReasoningBridge` + `fromAiSdkAgent`/`fromStreamText`/`fromStreamFactory` + `RunStore`), `@asyncdot/voice-bridge-mastra` (`fromMastraAgent`), `@asyncdot/voice-server-workers-mastra` (the Mastra-on-edge suspend/resume worker — nodejs_compat + Paid tier + `CloudflareDOStorage`). Each: what it is, the minimal usage example (from the real call sites), and the one gotcha.

**Acceptance criteria:**
1. A `README.md` per the 4 packages above, accurate to the shipped API (usage examples must compile against the real exports — verify against the source, don't invent).
2. The Mastra-edge README documents the `nodejs_compat` + Paid-tier + `CloudflareDOStorage` + `{contextId→runId}` pointer requirements + the `fs`/no-workspace-tools caveat.
3. `pnpm -r typecheck` still green (docs-only — no code change); no edits outside the READMEs.
4. Commit `[S4-02] package READMEs for the Reasoner seam + adapters + Mastra-edge worker`.

### `S4-03` — RFC §9 risk closeout + backlog reconciliation (manager-authored)

**Description:** Walk RFC §9 risks — mark each resolved (with the commit/evidence) or moved to backlog with a citation. Reconcile the WBS §4 backlog with the program's KI items (KI-2-01/02, KI-3-01..05, B-01..04). Confirm the public seam (`Reasoner`/`ReasoningPart`/`ReasoningBridge`/adapters) matches RFC §4 (it does — surfaces unchanged across v2.0→v2.3; no further amendment).

**Acceptance criteria:**
1. RFC §9 each risk → resolved/backlogged with a citation (Mastra wire shapes RESOLVED v2.2; edge weight RESOLVED v2.3/Paid-tier; B4 RESOLVED via `restart`; latency RESOLVED via S1-00 gate; behavior drift RESOLVED via unchanged tests; scope creep — Realtime stays B-01).
2. WBS §4 backlog updated with KI-2-01/02 + KI-3-01..05.
3. A one-paragraph "1.0 status (on v2)" note: what shipped, what's backlog, no trunk merge this sprint.
4. Commit `[S4-03] RFC §9 risk closeout + backlog reconciliation`.

---

## 2. Universal DoD
- [ ] `pnpm -r typecheck` green (no code changes in S4; docs only).
- [ ] No new deps, no new external services, **no trunk PR / no merge to main**.
- [ ] Each story committed `[S4-{nn}]` on `v2`.
- [ ] S4-02 (IC) proof JSON + manager PROCEED; S4-01/S4-03 manager-authored.

## 3. Test plan
No new tests (docs + report + closeout). Gate = `pnpm -r typecheck` green + READMEs accurate to the shipped exports (manager spot-checks usage examples against source).

## 4. Demo
The consolidated evidence: the latency report (S4-01) + the three already-proven live demos cited in it + the RFC §9 closeout (S4-03). No live re-run.

## 5. Risks specific to this sprint
| Risk | Mitigation |
|------|------------|
| README usage examples drift from the real API | verify each example against the source exports before commit |
| Over-claiming "1.0/released" | frame as "released on v2"; trunk merge is explicitly out of scope (user-directed) |

## 6. Open questions
- None blocking. The trunk PR (program capstone) is deferred per the user ("keep it as v2"); a future session/PR can merge `v2`→`main` when the user chooses.
