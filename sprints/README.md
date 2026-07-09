# Sprints

Operating system for the IU Substrate build (Syrinx vNext, Phase 0).

| File / Folder | Role |
|---------------|------|
| [`WBS.md`](./WBS.md) | Work breakdown — stories, universal DoD. **The plan.** |
| [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md) | Paste once — long-running program session. **The driver.** |
| [`STATE.md`](./STATE.md) | Where we are now + build branch. **The pointer.** |
| [`templates/`](./templates/) | PLAN, STORY-BRIEF, PROCEED-EVIDENCE, REVIEW-r1, WARMDOWN, HANDOFF. **The shape.** |
| `sprint-{N}/` | Per-sprint history. |

Source RFC: [`docs/rfc-incremental-unit-substrate.md`](../docs/rfc-incremental-unit-substrate.md). This sprint OS is Phase 0 of the bound Plan Desk project "Syrinx vNext".

---

## How a sprint runs

Build branch: see [`STATE.md`](./STATE.md) § Build branch (`plan/iu-substrate`). No commits to `main` mid-sprint.

### Phase A — implementation

1. Paste [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md).
2. Read STATE → WBS → prior HANDOFF.
3. Write `sprint-{N}/PLAN.md`.
4. Per story:
   - Run **`/code-understand`** when the story touches unfamiliar code; link `.understanding/<slug>.md` in the brief.
   - Write `brief-{story}.md` → `/delegate --mode impl` (`grok`) → proof JSON → atomic commit `[S{N}-{nn}]`.
   - Manager: read the diff + re-run the proof commands (`verify-handoff-proof.sh` or raw `pnpm`) → `proceed-S{N}-{nn}.md` (**PROCEED** / **HOLD**).

No review workers between stories. Live smokes are manager-run.

### Phase B — after all stories **PROCEED**

1. **Manager review** → `review-sprint.md` (sandwich; `REVIEW-r1.md` shape).
2. **Fix pass** → `[S{N}-fix]`.
3. Optional: `/delegate-review` if adversarial second opinion is needed.

### Close

WARMDOWN + HANDOFF + STATE → `[S{N}-close]`. Sync the Plan Desk task. Default: continue to N+1 in same session.

---

## Roles

| Role | Phase | Job |
|------|-------|-----|
| **Manager** | A + B + close | Plan, brief, proceed evidence, review, fix, warm-down, live smokes. Owns final diff. |
| **IC (`grok`)** | A (+ fix briefs) | One story, proof JSON, atomic commit. Fresh process per story. |
| **Explorer (`/code-understand`)** | Before brief | Map existing code when blast radius is unclear. Read-only. |

Ad-hoc without sprint OS → **`/managed-session`**. Adversarial second opinion → **`/delegate-review`** (not a sprint template).

---

## Commits

| Commit | Owner |
|--------|-------|
| `[S{N}-{nn}]` per story | `grok` (IC) |
| `[S{N}-fix]` | manager |
| `[S{N}-close]` | manager |

---

## What lives where

| You want to know... | Read... |
|---------------------|---------|
| What's the plan? | [`WBS.md`](./WBS.md) |
| What sprint are we in? | [`STATE.md`](./STATE.md) |
| How does a session run? | [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md) |
| What did sprint N do? | `sprint-{N}/WARMDOWN.md` |
| What does sprint N+1 need? | `sprint-{N}/HANDOFF.md` |
| Why was decision X made? | `review-sprint.md` + `proceed-*.md` |
| Code map before build | `.understanding/<slug>.md` |
| The source spec | [`docs/rfc-incremental-unit-substrate.md`](../docs/rfc-incremental-unit-substrate.md) |
