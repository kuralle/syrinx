# Proceed Evidence — `S3-03` bridge: pointer RunStore + suspended handling + (B4) onResumeConflict

> **Manager artifact — Phase A.**

- **Id:** `S3-03` · **Commits:** `d753399` (IC) + `162629f` (manager fix — see below) · **IC slug:** `s3-03`

## Checklist (manager — read diff)

- [x] Diff read — `index.ts` (`RunStore`/`RunPointer` + `ReasoningBridge` suspend/resume logic) + `index.test.ts` (5 new tests). The existing **9 `index.test.ts` assertions unchanged** (only additions; no `-` assertion lines).
- [x] `RunStore` is **pointer-only** (`save(contextId, runId)` / `takePending(contextId)→RunPointer|null` / `discard(contextId)`) per RFC §4.6 v2.3 — Mastra owns the snapshot.
- [x] Constructor backward-compatible: `(reasoner, opts={})`; one-arg call sites (`live-session.ts`, examples) compile unchanged; `onResumeConflict:"replay"` **throws** at construction (explicit, not silently-wrong).
- [x] `suspended` case (terminal): speak `prompt` if not already emitted, `llm.done`, `rememberTurn`, push `reasoning.suspended`, `runStore.save(contextId, runId)`, `return`.
- [x] Pending-run resume: `takePending(contextId)` at turn start → builds `turn.resume:{runId, data:userText}`; post-resume `finish` → `runStore.discard(contextId)`.
- [x] **(B4) default restart:** the `interrupt.llm` handler discards the pending run (when `runStore` set + not `replay`) → barge-in on a suspended run drops the pointer → next turn re-asks fresh (never `resumeStream` a stale checkpoint).
- [x] No `@ts-ignore`/suppression.

**Proof gate / verification:** the IC's proof correctly reported `cmd:typecheck_all` **unsatisfied** (PROOF_INVALID) — `pnpm -r typecheck` genuinely failed. **Root cause: my S3-02 verification gap**, not S3-03: S3-02 made `resumeStream` **required** on `MastraAgentLike`, breaking the S2-02 example test's fake agent (only implemented `stream`); my S3-02 proceed check ran only the mastra-package typecheck, not `pnpm -r typecheck`. Manager fix `162629f` adds a `resumeStream` stub to that fake.

**Independent verification (post-fix):**
- `pnpm -r typecheck` → exit 0.
- `pnpm --filter @asyncdot/voice-bridge-aisdk test` → **23/23** (9 existing unchanged + 9 adapter + 5 new suspend/resume).
- `pnpm -r test`: the **Sprint-3 packages all pass**; 2 failures (`voice-server-websocket` send_after_close + smartpbx, `voice-stt-google` Smart-Turn-EOS) are **"Test timed out in 5000ms" under concurrent load** in **untouched** packages — all pass in isolation (`voice-stt-google` 5/5; `voice-server-websocket` 196/197). Pre-existing flakiness (KI-2-01 class), not S3-03.

**Verdict:** `PROCEED`

## Notes

- **Process fix (carry forward):** when a story changes a **shared exported type** (here `MastraAgentLike`), the proceed check must run `pnpm -r typecheck`, not just the owning package's. Applied retroactively here.
- **KI-3-01 (expand KI-2-01):** `pnpm -r test` is not reliably green under concurrency — `voice-server-websocket` (smartpbx heartbeat, send_after_close) + `voice-stt-google` (Smart-Turn EOS) are 5 s-timeout tests that starve under parallel load; all pass in isolation. Backlog: raise these timeouts / use fake timers / serialize. **Not a Reasoner-bridge regression.**
- **Carry to S3-04:** the bridge now consumes a `RunStore`; S3-04 builds the dedicated Mastra-on-edge worker (`CloudflareDOStorage` for Mastra's snapshot + a SQL `DurableObjectRunStore` implementing this pointer interface) from `sprints/sprint-3/spike-reference/`, + the workerd two-turn test. Deploy = Paid tier, outward-facing — surface first.
