# Handoff — Sprint 3 → Sprint 4

> **One page. Read this before doing anything else.** Depth in [`WARMDOWN.md`](./WARMDOWN.md).

---

## State of the world (one paragraph)

Sprint 3 (suspend/resume DO path) is complete. After research + a spike (`spike-reference/`) corrected the architecture (RFC v2.3 — Mastra owns the snapshot), the path ships as: bus packets (`reasoning.suspended`/`reasoning.resume`), a Mastra adapter that maps `tool-call-suspended`→`suspended` and routes `turn.resume`→`resumeStream`, a `ReasoningBridge` with a pointer `RunStore` + (B4) `onResumeConflict` default `restart`, and a **dedicated Mastra-on-edge worker** (`@asyncdot/voice-server-workers-mastra`, `nodejs_compat`, `CloudflareDOStorage` for Mastra's snapshot + a SQL `{contextId→runId}` pointer). Suspend→hibernate→resume is proven in workerd (two-turn test) **and deployed live** (`voice-server-workers-mastra.mithushancj.workers.dev`, Version `40a15353`, Paid tier, real `gpt-4.1-mini`). The AI-SDK product worker stays Mastra-free + edge-clean. All three backends now work: **AI SDK (Sprint 1, deployed), Mastra (Sprint 2, Node + Sprint 3, edge), suspend/resume (Sprint 3, deployed).** Sprint 4 is polish + 1.0 release.

---

## Sprint 4 goal (verbatim from WBS)

**The bridge generalization is released: a latency report across both backends within budget, docs current, every RFC risk resolved or backlogged, and a final live demo through AI SDK + Mastra plus suspend/resume.**

Full section: `sprints/WBS.md` § Sprint 4 (stories S4-01…S4-03).

---

## Read these first (before any story)

1. `sprints/STATE.md` + `sprints/WBS.md` § Sprint 4.
2. `sprints/sprint-3/WARMDOWN.md` §10 (pointers) + §4 (KI-3-01..05 backlog).
3. `docs/latency-budget.md` — append the cross-backend report (S4-01); the S1-00 baseline + band are the denominator.
4. `docs/rfc-reasoner-bridge.md` §9 (risk closeout, S4-03) + §7 (validation).
5. The shipped APIs to document (S4-02): `packages/voice/src/reasoner.ts`, `voice-bridge-aisdk` (`ReasoningBridge`, `from-ai-sdk`, `RunStore`), `voice-bridge-mastra` (`from-mastra`), `voice-server-workers-mastra`.

---

## Traps to know about

- **KI-3-01:** `pnpm -r test` is flaky under concurrency — judge green by running the touched packages in isolation; the flakes (`voice-server-websocket`, `voice-stt-google`) are pre-existing 5 s-timeout tests, not Reasoner-bridge regressions.
- **Latency report (S4-01):** use the **short fixture** (`SYRINX_WS_MAX_TURNS=1`) per the credit directive; compare AI-SDK vs Mastra LLM-TTFT to the S1-00 band — both already shown within band (Sprint 1 P50 mean 2705; Sprint 2 2967/884). The Mastra-edge worker's CPU/cold-start (~249 ms startup) is separate from LLM-TTFT.
- **No new deps / no new external services** in Sprint 4 — it's report + docs + closeout + the trunk PR.
- **Capstone = the trunk PR** (`v2` → `main`). **Confirm with the user before opening/merging.**

---

## Open issues that block sprint 4

No blockers. KI-3-01..05 are backlog/nits.

---

## Start by running

```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx && cat sprints/STATE.md && git branch --show-current && pnpm -r typecheck
```

---

## When you're done

Sprint 4 is the last sprint — its exit is the trunk PR (program complete). New session resumes via `sprints/SESSION_KICKOFF_PROMPT.md` + `sprints/STATE.md` + this HANDOFF.
