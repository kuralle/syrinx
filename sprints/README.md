# Sprints

Operating system for the Reasoner Bridge build (source: `docs/rfc-reasoner-bridge.md`).

| File / Folder | Role |
|---------------|------|
| [`WBS.md`](./WBS.md) | Work breakdown — stories, universal DoD. **The plan.** |
| [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md) | Paste once — long-running program session. **The driver.** |
| [`STATE.md`](./STATE.md) | Where we are now + build branch (`v2`). **The pointer.** |
| [`templates/`](./templates/) | PLAN, STORY-BRIEF, PROCEED-EVIDENCE, REVIEW-r1, WARMDOWN, HANDOFF. **The shape.** |
| `sprint-{N}/` | Per-sprint history. |

---

## How a sprint runs

Build branch: see [`STATE.md`](./STATE.md) § Build branch (`v2`). No commits to `main` mid-sprint.

### Phase A — implementation

1. Paste [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md).
2. Read STATE → WBS → prior HANDOFF → the RFC sections STATE names.
3. Write `sprint-{N}/PLAN.md`.
4. Per story:
   - Run **`/code-understand`** when the story touches unfamiliar code; link `.understanding/<slug>.md` in the brief.
   - Write `brief-{story}.md` → `/delegate --mode impl` (cursor) → proof JSON → atomic commit `[S{N}-{nn}]`.
   - Manager: `verify-handoff-proof.sh` → `proceed-S{N}-{nn}.md` (**PROCEED** / **HOLD**).

No review workers between stories.

### Phase B — after all stories **PROCEED**

1. **Manager review** → `review-sprint.md` (sandwich; `REVIEW-r1.md` shape).
2. **Fix pass** → `[S{N}-fix]`.
3. Optional: `/delegate-review` if adversarial second opinion is needed.

### Close

WARMDOWN + HANDOFF + STATE → `[S{N}-close]`. Default: continue to N+1 in same session.

---

## This build, in one paragraph

Generalize the cascading LLM bridge from "wraps the AI SDK" to "drives any backend that streams" (AI SDK `ToolLoopAgent`, Mastra `Agent`, raw `streamText`) **without changing the pipeline primitive** — the bridge stays a bus-native `VoicePlugin`; only the seam it drives becomes a normalized `Reasoner`. Five sprints: 0 seam foundation → 1 re-home the bridge (zero behavior change, live) → 2 Mastra adapter → 3 suspend/resume DO path → 4 polish + 1.0. **Realtime / speech-to-speech is out of scope** (backlog B-01). **Latency is the gate** — every sprint proves LLM-TTFT is unchanged (RFC §7a).

---

## Roles

| Role | Phase | Job |
|------|-------|-----|
| **Manager** | A + B + close | Plan, brief, proceed evidence, review, fix, warm-down. Owns final diff. |
| **IC (cursor)** | A (+ fix briefs) | One story, proof JSON, atomic commit. Fresh process per story. |
| **Explorer (`/code-understand`)** | Before brief | Map existing code when blast radius is unclear. Read-only. |

Ad-hoc without sprint OS → **`/managed-session`**. Adversarial second opinion → **`/delegate-review`** (not a sprint template).

---

## Commits

| Commit | Owner |
|--------|-------|
| `[S{N}-{nn}]` per story | cursor (IC) |
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
| The source design | `docs/rfc-reasoner-bridge.md` |
