# Work Breakdown Structure — Reasoner Bridge

> **The build plan, sprint by sprint, end-to-end.** Spans the Reasoner-bridge RFC (`docs/rfc-reasoner-bridge.md`) — a framework-agnostic reasoning seam that lets the cascading LLM bridge drive any backend that streams (AI SDK `ToolLoopAgent`, Mastra `Agent`, raw `streamText`) without changing the pipeline primitive. Every sprint is an end-to-end demoable slice, not a horizontal slab. Cadence and engineering practice are the same across all sprints.

---

## 1. Cadence and engineering practice

### 1.1 Cadence
- **1w sprints.** Plan at sprint start; execute Phase A through the week; manager review (Phase B) before close.
- **One sprint goal**, expressed as a single sentence with a verifiable outcome.
- **2–5 stories per sprint.** Smaller is better. Each story ships independently.
- **No carry-over.** If a story slips, it goes back to the backlog, not the next sprint as-is. Rewrite the story.

### 1.2 Definition of Done (universal)
A sprint's stories are collectively Done when **all** of the following hold:

1. Every story commits atomically (`[S{N}-{nn}] {title}`) on the **active build branch** (`v2` — see `sprints/STATE.md` § Build branch) with `pnpm -r typecheck` + `pnpm -r test` green on Node, and the edge bundle clean (`bash scripts/verify-edge-bundle.sh`) where the story touches edge-reachable code.
2. Unit tests written for every new exported function / class. **Coverage is not the metric**; *behavioral coverage* is — every public surface tested with at least one happy-path and one failure-path test.
3. **Passes sprint-level manager review (Phase B — after every story has proceed evidence):** manager sandwich review on full diff + briefs + proceed artifacts; blockers/majors resolved in fix pass. Optional `/delegate-review` when adversarial second opinion is explicitly needed.
4. **Public surfaces match the source RFC.** Diffs to the RFC require an explicit RFC amendment in the same sprint (the `Reasoner` / `ReasoningPart` / `ReasoningBridge` / adapter signatures are RFC §4).
5. **Latency gate (non-negotiable, RFC §7a + M3):** the seam adds no measurable latency — **LLM-TTFT P50/P95 within the captured baseline variance band**, measured on the stable local harness `pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-interactive` (NOT the noisy deployed worker, and NOT a literature budget). The baseline + band are captured once on `v2` HEAD before Sprint 1 (S1-00) and recorded in `docs/latency-budget.md`. A regression beyond the band is a blocker, not a follow-up.
6. Docs updated: at minimum the package's README; at most an RFC delta.
7. Manual demo artifact captured per story or per sprint (transcript / test log / deployed-worker turn).
8. **No `--no-verify`, no type-suppression, no silent-catch shortcuts.** If you can't meet a check, change the design, not the gate.

### 1.3 Branching and commits
- **Build branch:** `v2` (canonical name in `sprints/STATE.md` § Build branch). All Phase A story commits and Phase B fix/closeout commits land on this branch. **Do not commit to `main` during a sprint session** — merge to trunk happens via PR after the sprint ships.
- IC commits per-story atomic implementations on the build branch. Manager commits the fix pass + closeout commits on the same branch.
- Every commit message includes the story id (or `[S{N}-fix]` / `[S{N}-close]` for manager commits) and a body summarizing the diff. End commit messages with the project's `Co-Authored-By` trailer.
- Demo artifact links live in the commit body.

### 1.4 The review loop (proceed evidence in Phase A; manager review in Phase B)

**Phase A — IC + proceed evidence (no review workers):**

1. **IC implementation.** `cursor` fired fresh per story. Proof JSON, atomic commit. One worker = one story = one context window.
2. **Code map (when needed).** Before briefing, manager runs **`/code-understand`** for unfamiliar surfaces; links `.understanding/<slug>.md` in brief **Read These First**.
3. **Proceed evidence (manager).** After each story: diff + `verify-handoff-proof.sh` → `proceed-S{N}-{nn}.md`. **`PROCEED`** → next story. **`HOLD`** → re-delegate IC only.
4. Repeat until every story has **`PROCEED`**.

**Phase B — manager review (only after Phase A complete):**

5. **Manager sandwich review.** Full sprint diff + every brief + every proceed file → `review-sprint.md` (`REVIEW-r1.md` shape).
6. **Manager fix pass.** Commit `[S{N}-fix] {description}`. Optional `/delegate-review` — not default.
7. Sprint closes when WARMDOWN + HANDOFF + STATE-update commit lands.

### 1.5 Sprint warm-down (handoff to the next session)
Last hour of every sprint. Two artifacts:

1. `sprints/sprint-N/WARMDOWN.md` — what shipped, what's working, what's not, open issues, decisions made, RFC amendments this sprint.
2. `sprints/sprint-N/HANDOFF.md` — a one-page primer for the next session: read-me-first, current state of the world, sprint N+1 starting state.

The next session reads HANDOFF first, WARMDOWN if it needs depth.

---

## 2. The roadmap

| Sprint | Phase | Goal (one sentence) |
|--------|-------|---------------------|
| 0 | Seam foundation | The `Reasoner` seam + `ReasoningPart` union exist in core and the AI SDK adapter maps `TextStreamPart` → `ReasoningPart` with no buffering, unit-tested. |
| 1 | Re-home the bridge | The production bridge drives a `Reasoner` internally with **zero behavior change** (the 9 existing bridge tests' assertions unchanged; construction line adapts via `fromStreamFactory`) and is constructed with an explicit `fromAiSdkAgent(...)`; a live turn runs on the deployed worker with LLM-TTFT within the captured baseline band. |
| 2 | Mastra adapter | A Mastra `Agent` drives the same bridge via `fromMastraAgent`; a live worker turn runs through a Mastra backend, edge bundle stays clean, LLM-TTFT within budget. |
| 3 | Suspend / resume | A Mastra workflow `suspend()` → DO-persisted `runId` → resume across two voice turns survives Durable-Object hibernation (workerd test). |
| 4 | Polish + 1.0 | Latency report across both backends, docs, success-metric gate, backlog/risk closeout — the bridge generalization is released. |

The phases above map to the source RFC as follows:

- **Sprint 0** → RFC §4.2 (the `Reasoner` seam + `ReasoningPart` union), §4.3 (AI SDK → part mapping), §7a (no-buffering latency invariant). RFC §8 commits 1.1–1.2.
- **Sprint 1** → RFC §4.4 (the generalized bridge), §4.5 (what stays verbatim — history + spoken-prefix barge-in + retry), §7a (latency gate). RFC §8 commits 1.3–1.5.
- **Sprint 2** → RFC §4.3 (Mastra → part mapping), §9 (edge-bundle weight risk). RFC §8 commits 2.1–2.4.
- **Sprint 3** → RFC §4.6 (suspend/resume across turns + the DO `runId` path). RFC §8 commits 3.1–3.5.
- **Sprint 4** → RFC §7 (validation), §7a (latency report), §9 (risks / open questions) closeout.

---

## 3. Sprint detail

The format below repeats per sprint. Stories use the id pattern `S{N}-{nn}` (e.g. `S0-01`).

### Sprint 0 — Seam foundation

**Goal:** The `Reasoner` seam + `ReasoningPart` union exist in `@asyncdot/voice`, and the AI SDK adapter maps `TextStreamPart` → `ReasoningPart` with no buffering, fully unit-tested.

| Story | Description | DoD |
|-------|-------------|------|
| S0-01 | Add the `Reasoner` seam + `ReasoningPart` union (types only) in `packages/voice/src/reasoner.ts`, exported from `voice/src/index.ts`. Include the `suspended` **and `error`** variants now (B1 — designed once; `error` wired in Sprint 1, `suspended` in Sprint 3). No runtime consumers yet. | `pnpm --filter @asyncdot/voice typecheck` green; the union matches RFC §4.2 (incl. `error`); the `LATENCY INVARIANT` doc-comment is on `Reasoner.stream`. |
| S0-02 | `fromAiSdkAgent` + `fromStreamText` **+ `fromStreamFactory`** adapters → `Reasoner` in `packages/voice-bridge-aisdk/src/from-ai-sdk.ts`; map the **full** `TextStreamPart` union → `ReasoningPart` per RFC §4.3 — **`error`/`tool-error`/`finish-step` → `error` (B1, not dropped)**; `await` `agent.stream()` (returns a `Promise`, B3); yield each part immediately (no buffering). `fromStreamFactory` preserves the existing test seam (B2). | `pnpm --filter @asyncdot/voice-bridge-aisdk test` green; new adapter tests cover the full table incl. the **error→`error`** paths + a dropped-part case. |

**Demo:** a unit test that feeds a scripted `fullStream` of `TextStreamPart`s through `fromAiSdkAgent` and asserts the exact normalized `ReasoningPart` sequence (incl. `finish`), runnable and green.

**Dependencies:** none.

**Source RFC §:** §4.2 (Reasoner/ReasoningPart), §4.3 (AI SDK mapping), §7a (no-buffering invariant). Commits 1.1–1.2.

**Sprint-specific risks:**
- AI SDK v6 `TextStreamPart` field names drift → detection: typecheck against the installed `ai@^6` types + the adapter unit test → mitigation: the mapping lives in one function; pin the version.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 1 — Re-home the bridge (zero behavior change + live)

**Goal:** The production bridge drives a `Reasoner` internally with zero behavior change (the 9 `index.test.ts` tests' assertions unchanged; construction adapts via `fromStreamFactory` — B2), is constructed with an explicit `fromAiSdkAgent(...)` (no auto-wrap — B3), and runs a live turn on the deployed worker with LLM-TTFT within the S1-00 baseline band (M3).

| Story | Description | DoD |
|-------|-------------|------|
| S1-00 | **(M3)** Capture the latency baseline on `v2` HEAD **before any refactor**: run `smoke:websocket-interactive` ×3, record LLM-TTFT P50/P95 + the variance band in `docs/latency-budget.md`. This is the denominator every later latency gate uses. | baseline + band committed to `docs/latency-budget.md`; 3 runs captured. |
| S1-01 | Drive `AISDKBridgePlugin` from a `Reasoner` internally: replace the `streamResponse`/`fullStream` loop with `reasoner.stream(turn)` + a **6-case** `ReasoningPart` switch (incl. `error` → the existing retry/`llm.error` path, B1). Keep history, spoken-prefix barge-in, retry, supersede **identical**. No buffering. | **(B2)** The 9 `index.test.ts` tests: **assertions/behavior unchanged**; each construction line adapts `new AISDKBridgePlugin(fn)` → `new ReasoningBridge(fromStreamFactory(fn))`. `pnpm --filter @asyncdot/voice-bridge-aisdk test`. **LLM-TTFT P50/P95 within the S1-00 baseline band** (RFC §7a/M3). |
| S1-02 | **(B3)** Rename to `ReasoningBridge`; constructor accepts a **`Reasoner` only** — callers wrap explicitly via `fromAiSdkAgent`/`fromStreamText`/`fromStreamFactory`. **No `.stream()`-probe auto-wrap.** Update `voice-server-workers/live-session.ts` + examples to the explicit wrap. Zero-debt: remove `AISDKBridgePlugin` (or thin alias only if a caller needs it). | `pnpm -r typecheck && pnpm -r test` green; no call site uses auto-wrap; no behavior change. |
| S1-03 | Live worker proof (functional): `verify-edge-bundle.sh` clean; opt-in live worker turn; deploy + drive one turn on the deployed worker. Latency gate is the **local harness**, not the deployed turn. | `bash scripts/verify-edge-bundle.sh` clean; `SYRINX_LIVE_WORKER_TEST=1 pnpm --filter @asyncdot/voice-server-workers test` passes; deployed `/ws` turn transcribes + returns TTS; **`smoke:websocket-interactive` LLM-TTFT within the S1-00 band** (deployed turn is functional proof only). |

**Demo:** a deployed-worker live turn (transcript + TTS bytes) plus an LLM-TTFT before/after comparison showing no regression.

**Dependencies:** Sprint 0.

**Source RFC §:** §4.4 (generalized bridge), §4.5 (preserved behavior), §7 + §7a (latency). Commits 1.3–1.5.

**Sprint-specific risks:**
- A behavior drift hiding inside the refactor → detection: the unchanged 9 tests + the LLM-TTFT measurement → mitigation: every commit is behavior-preserving and independently revertible.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 2 — Mastra adapter

**Goal:** A Mastra `Agent` drives the same `ReasoningBridge` via `fromMastraAgent`, with a live worker turn through a Mastra backend, the edge bundle still clean, and LLM-TTFT within budget.

| Story | Description | DoD |
|-------|-------------|------|
| S2-01 | New `@asyncdot/voice-bridge-mastra` package: `fromMastraAgent(agent) → Reasoner`; map `processDataStream` payload-wrapped chunks → `ReasoningPart` per RFC §4.3. Bridge Mastra's callback stream to an async-iterable via a **zero-delay queue** (no accumulation — RFC §7a). | `pnpm --filter @asyncdot/voice-bridge-mastra typecheck` green; deps limited to `@mastra/core` (+ `@mastra/ai-sdk` only if needed). |
| S2-02 | Mastra adapter unit tests: chunk→part mapping + barge-in parity, driven by a scripted Mastra-shaped stream (no network). | `pnpm --filter @asyncdot/voice-bridge-mastra test` green incl. happy + failure + abort cases. |
| S2-03 | Drive `ReasoningBridge` with a Mastra agent via explicit `fromMastraAgent(agent)` (no auto-wrap — B3) + live worker turn through a Mastra backend. | `pnpm -r typecheck && pnpm -r test`; `verify-edge-bundle.sh` clean (gate Mastra to the Node build via a runtime-split export if it pulls Node-only deps); deployed live turn with a Mastra agent; **`smoke:websocket-interactive` LLM-TTFT within the S1-00 baseline band** (M3). |

**Demo:** a deployed live turn driven through a Mastra-backed `ReasoningBridge`, transcript + TTS.

**Dependencies:** Sprint 1.

**Source RFC §:** §4.3 (Mastra mapping), §4.4 (explicit adapter), §9 (edge-bundle weight). Commits 2.1–2.4.

**Sprint-specific risks:**
- Mastra wire shapes (`processDataStream` chunk fields) unverified vs a running build → detection: typecheck against pinned `@mastra/core` + the scripted unit test → mitigation: confirm the chunk shape at S2-01 before finalizing the mapping.
- `@mastra/core` bloats the edge bundle → detection: `verify-edge-bundle.sh` → mitigation: runtime-split Mastra to the Node build (mirror the `voice-ws` `./node` export).

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 3 — Suspend / resume DO path

**Goal:** A Mastra workflow `suspend()` parks a run that is persisted by `runId` in the Durable Object, asked of the user, and resumed on a later voice turn — surviving DO hibernation between turns (proven in workerd).

| Story | Description | DoD |
|-------|-------------|------|
| S3-01 | Add `reasoning.suspended` + `reasoning.resume` packets + factories to `@asyncdot/voice` (`ReasonerTurn.resume` already exists from S0-01). | `pnpm --filter @asyncdot/voice typecheck` green; packet-factory tests. |
| S3-02 | Mastra adapter emits the terminal `suspended` part (map `tool-call-suspended` → `{type:"suspended", runId, …}`) and routes a resume turn to `agent.resumeStream(data, {runId})`. | `pnpm --filter @asyncdot/voice-bridge-mastra test` with a scripted suspend → resume sequence. |
| S3-03 | Bridge handles the `suspended` part: speak `prompt`, emit `reasoning.suspended`, persist `{runId, contextId, payload}` via an injected `RunStore`; on a turn with a pending run, build a `resume` turn. **(B4)** Implement `onResumeConflict: "restart" \| "replay"` (default `restart`) — if a spoken-prefix correction landed since suspend, discard + re-ask rather than `resumeStream` (the suspended checkpoint holds the uncorrected turn). Barge-in on a suspended run discards it. | bridge unit tests with a fake `RunStore`: clean suspend→resume, **suspend→barge-in→resume → `restart`**, barge-in-discards. |
| S3-04 | `DurableObjectRunStore` on `ctx.storage.sql` (one `reasoning_runs` table, mirrors `DurableObjectSessionStore`); wire into the DO; alarm-GC stale rows (TTL). Workerd test: suspend → DO hibernates → resume across two turns. | `pnpm --filter @asyncdot/voice-server-workers test` incl. the new suspend→hibernate→resume-across-two-turns workerd/Miniflare test. |

**Demo:** a Miniflare two-turn run — suspend on turn 1, DO evicted, resume on turn 2 by `runId`, asserted end-to-end.

**Dependencies:** Sprint 2.

**Source RFC §:** §4.6 (suspend/resume + DO `runId`), §9. Commits 3.1–3.5.

**Sprint-specific risks:**
- **(B4)** Spoken-prefix correction vs Mastra's resumed checkpoint: a barge-in between suspend and resume leaves the run's checkpoint uncorrected, diverging from the bridge's history → detection: the `suspend→barge-in→resume` unit test (S3-03) + the two-turn workerd test → mitigation: `onResumeConflict` defaults to `restart` (discard + re-ask); `replay` is opt-in per backend.
- "next user turn" → `resume.data` mapping policy → detection: review at S3-03 → mitigation: the orchestrator (turn-routing owner) maps it, keeping the bridge a pure function of the turn.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 4 — Polish + 1.0

**Goal:** The bridge generalization is released: a latency report across both backends within budget, docs current, every RFC risk resolved or backlogged, and a final live demo through AI SDK + Mastra plus suspend/resume.

| Story | Description | DoD |
|-------|-------------|------|
| S4-01 | Latency report: measure LLM-TTFT P50/P95 for the AI SDK and Mastra backends vs the RFC §7a budget; append to `docs/latency-budget.md`. | report committed; LLM-TTFT within the ~350 ms stage budget; no seam-attributable regression across sprints. |
| S4-02 | Docs + READMEs: package READMEs for the `Reasoner` seam + both adapters; an RFC delta if any public surface drifted from RFC §4. | docs updated; RFC §4 matches the shipped API (amend in the same commit if it drifted). |
| S4-03 | Backlog + risk closeout + success-metric gate: confirm every RFC §9 risk is resolved or moved to backlog with a citation; final demo runs a live deployed turn through an AI SDK agent **and** a Mastra agent **and** a suspend/resume two-turn run. | RFC §9 risks resolved/tracked; the three-way live demo passes; `pnpm -r typecheck && pnpm -r test` + edge bundle clean. |

**Demo:** end-to-end — a deployed live turn through an AI SDK agent, one through a Mastra agent, and a suspend→resume two-turn run, accompanied by the latency report.

**Dependencies:** Sprint 3.

**Source RFC §:** §7 (validation), §7a (latency report), §9 (risks/open questions).

**Sprint-specific risks:**
- Scope creep into Realtime / S2S → detection: PR review → mitigation: Realtime is explicitly out of scope (RFC §3) — backlog only (B-01).

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared; bridge generalization tagged/merged via PR.

---

## 4. Backlog (deferred to v1.x or v2)

| ID | Item | Earliest | Source RFC § |
|----|------|----------|--------------|
| B-01 | Realtime / speech-to-speech `RealtimeBridge` — a sibling `VoicePlugin` (consumes `user.audio_received`, emits `tts.audio`); a `Reasoner` plugs in as a delegate tool. | v2 | §3 (non-goals), §9 |
| B-02 | First-class multi-agent / agent-network handling (currently flattens into one `agent.stream()`; only the responding agent's text is spoken). | v1.x | §9 |
| B-03 | Alternative Mastra adapter via `@mastra/ai-sdk` `toAISdkStream()` (reuse the AI SDK mapping path instead of `processDataStream`). | v1.x | §4.3 |
| B-04 | `AISDKBridgePlugin` deprecated-alias removal (if a compat alias was kept in S1-02). | v1.x | §8 (1.4) |

---

## 5. Risks tracked across sprints

| Risk | Sprint(s) it materializes | Owner | Mitigation |
|------|---------------------------|-------|------------|
| Latency regression from the seam (extra hop / buffering) | 0–3 | manager | LLM-TTFT P50/P95 gate every sprint (RFC §7a); no-buffering invariant on `Reasoner.stream`; revert any commit that regresses. |
| Mastra wire shapes (`tool-call-suspended`, `resumeStream`, `processDataStream`) unverified vs a running build | 2–3 | IC + manager | Confirm against pinned `@mastra/core` at S2-01 before finalizing mappings. |
| Edge-bundle weight from `@mastra/core` | 2 | manager | `verify-edge-bundle.sh` gate; runtime-split Mastra to the Node build if it pulls Node-only deps. |
| Spoken-prefix correction lost on Mastra resume (B4) | 3 | manager | `onResumeConflict` default `restart` (discard + re-ask) so a corrected turn is never overwritten by a stale checkpoint; `replay` opt-in; `suspend→barge-in→resume` test. |
| Latency gate measured against the wrong denominator (M3) | 0–3 | manager | Gate on `smoke:websocket-interactive` vs the S1-00 captured baseline band — never the literature budget or the noisy deployed worker. |
| Behavior drift hiding in the step-1 refactor | 1 | manager | The 9 unchanged bridge tests + LLM-TTFT measurement; behavior-preserving, revertible commits. |
| Scope creep into Realtime/S2S | 4 | manager | Out of scope (RFC §3); backlog B-01 only. |

---

## 6. The role of this document

This WBS is the *plan*, not the *prompt*. The program driver lives at [`./SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md). The current sprint pointer lives at [`./STATE.md`](./STATE.md). Templates live under [`./templates/`](./templates/).

When this WBS conflicts with the source RFC (`docs/rfc-reasoner-bridge.md`), **the RFC wins** — amend this document in the same PR.
