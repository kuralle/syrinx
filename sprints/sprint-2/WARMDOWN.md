# Sprint 2 — Warm-down

> **Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05.
> **Sprint window:** 2026-06-05 (closed same day).
> **Outcome:** Goal achieved. A real OpenAI-backed Mastra `Agent` drives the same `ReasoningBridge` via `fromMastraAgent`; a live Node turn runs through it within the S1-00 latency band; the edge bundle stays Mastra-free.

---

## 1. Goal recap

**Sprint goal (from WBS):** a Mastra `Agent` drives the same `ReasoningBridge` via `fromMastraAgent`, with a live worker turn through a Mastra backend, the edge bundle still clean, and LLM-TTFT within budget.

**Did we hit it?** **Yes** (with one resolved WBS inconsistency). Both stories PROCEED; Phase B = Approve. The seam generalization is demonstrated: a second backend behind the same `Reasoner` with **zero `ReasoningBridge` change**. The "live *worker* turn" was resolved to a **Node** live turn — Mastra (201 deps) is Node-only by the edge hard-flag, so the deployed CF worker stays AI-SDK-backed; a "deployed Mastra turn" would have contradicted the RFC §9 edge constraint (user-confirmed).

---

## 2. Stories shipped

| Story | Status | Commit(s) | Notes |
|-------|--------|-----------|-------|
| S2-01 | Done | `415f762` (scaffold + RFC v2.2) + `c683d75` (adapter) | `@asyncdot/voice-bridge-mastra`: `fromMastraAgent` maps `output.fullStream` `{type,payload}` chunks → `ReasoningPart`; 7/7 tests; edge clean. |
| S2-02 | Done | `cec822f` | OpenAI-backed Mastra `Agent` → `ReasoningBridge` on the Node path; smoke swappable (`SYRINX_BRIDGE=mastra`); live turn within band; worker Mastra-free. |

No stories slipped. (WBS S2-01+S2-02 consolidated into one shippable unit; live story is S2-02 here.)

---

## 3. What's working

- `fromMastraAgent(agent) → Reasoner` (verified against `@mastra/core@1.41.0`), structurally identical to `fromAiSdkAgent`; `ReasoningBridge` drives it unchanged.
- Live Mastra Node turn: real STT→Mastra-LLM(gpt-4.1-mini)→TTS, transcript + TTS bytes, LLM-TTFT 2967/884 ms (within the S1-00 band).
- Edge bundle stays clean; `@mastra/core` (201 deps) confined to the Node example path; worker is Mastra-free.
- RFC amended to v2.2 (verified Mastra mechanism); §9 Mastra wire-shape risk RESOLVED.

---

## 4. What's not working / known issues

| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| KI-2-01 | `voice-server-websocket/src/smartpbx.test.ts:720` "heartbeat pings" is timing-flaky (`setTimeout(20ms)` race) — failed once under concurrent `pnpm -r test`, passed on re-run (197/197). **Pre-existing; Sprint 2 didn't touch that package.** | minor | backlog | widen the wait or use fake timers |
| KI-2-02 | Mastra demo agent is text-only (no tool parity with the AI-SDK `studentRelationsTools`). | nit | backlog | port tools to Mastra if a tool-calling demo is wanted |

---

## 5. Decisions made

- **Decision:** Mastra runs on the **Node path only**; the deployed CF worker stays AI-SDK-backed (no Mastra deploy). **Rationale:** `@mastra/core` = 201 transitive deps, Node-only — the edge hard-flag (RFC §9) forbids it in the worker bundle; the WBS "deployed Mastra turn" contradicted that. **Source:** PLAN §0 + user confirmation. **RFC amendment:** none needed (§9 already mandates the Node runtime-split).
- **Decision (RFC v2.2):** the Mastra mechanism is `output.fullStream` (`ReadableStream<ChunkType>`), not `processDataStream({onChunk})` — no zero-delay queue. **Source:** verified `@mastra/core@1.41.0` `.d.ts`. **RFC amendment:** §2/§4.3/§7a/§9 + changelog (commit `415f762`).
- **Decision:** `@mastra/core` is a **peerDependency** of the adapter (consumer-owned). **Rationale:** the adapter wraps a consumer-instantiated `Agent` — avoids dual-copy/`instanceof` hazards, keeps weight out of the package surface. **Source:** user direction.

---

## 6. Wiki / RFC amendments this sprint

RFC v2.2 — §2 / §4.3 (×2) / §7a / §9 + changelog (commit `415f762`): Mastra mechanism corrected to `fullStream`; §9 Mastra wire-shape risk RESOLVED. `Reasoner`/`ReasoningPart`/`ReasoningBridge` surfaces unchanged.

---

## 7. Metrics

- **New package:** `@asyncdot/voice-bridge-mastra` (`fromMastraAgent` + 7 adapter tests + 1 bus-integration test).
- **Diff:** +536 / −14 across 10 files (new package + adapter + tests + example wiring + RFC amendment).
- **Latency (Mastra path, gpt-4.1-mini):** LLM-TTFT 2967 / 884 ms — within the S1-00 band (≤ 3920 / ≤ 4530).
- **Deps:** `@mastra/core@1.41.0` (201 transitive) — Node-only; edge bundle unaffected.
- **Credits:** Mastra gate run with the short fixture (`SYRINX_WS_MAX_TURNS=1`), ×2.

---

## 8. Backlog updates

**Added:** KI-2-01 (smartpbx heartbeat flake), KI-2-02 (Mastra tool parity), plus the still-open B-03 (`@mastra/ai-sdk` `toAISdkStream()` alt path). **Removed:** none.

---

## 9. Retrospective

### Keep
Front-loading the wire-shape verification (install + read `.d.ts`) before writing the adapter — it turned the scariest unknown (callback stream + 201-dep edge weight) into a near-copy of the AI SDK adapter and produced a precise, verified brief. Making the smoke swappable (`SYRINX_BRIDGE=mastra`) gave a genuinely apples-to-apples latency gate.

### Change
The WBS carried a self-contradiction ("deployed Mastra turn" vs the edge hard-flag) that I caught only at S2-02 planning. Earlier RFC↔WBS consistency checks would surface these at sprint start. (Resolved + documented this sprint.)

### Try next
Sprint 3 (suspend/resume DO path) is the highest-coupling sprint — run `/code-understand` on the DO + `ReasoningBridge` suspend path before briefing (kickoff flags it). Verify the Mastra `resumeStream`/`tool-call-suspended` runtime behavior against `@mastra/core@1.41.0` the same way (already type-verified to exist).

---

## 10. Pointers for the next sprint (Sprint 3 — suspend/resume DO path)

- **Files to read first:** `docs/rfc-reasoner-bridge.md` §4.6 (suspend/resume + DO `runId`) + §9 + §8 commits 3.1–3.5; `packages/voice/src/reasoner.ts` (`ReasoningPart.suspended` + `ReasonerTurn.resume` already exist from S0-01); `packages/voice-bridge-mastra/src/from-mastra.ts` (the `// Sprint 3` marker where `tool-call-suspended` maps to a terminal `suspended` part); `packages/voice-server-workers/src/*` (the DO + `DurableObjectSessionStore` to mirror for `DurableObjectRunStore`); `packages/voice-bridge-aisdk/src/index.ts` (`ReasoningBridge` — add the `suspended` handling + `onResumeConflict`).
- **Traps:** (1) **(B4)** spoken-prefix reconciliation on resume — `onResumeConflict: "restart" | "replay"` (default `restart`): if a barge-in correction landed since suspend, discard + re-ask rather than `resumeStream` a stale checkpoint. (2) The DO must persist `{runId, contextId, payload}` and survive **hibernation** between turns (workerd test). (3) Suspend must not add latency to non-suspending turns (§7a gate). (4) `@mastra/core` Mastra-on-edge is still forbidden — but the **DO `RunStore` is edge code** (SQL on `ctx.storage.sql`), Mastra-free; the Mastra `resumeStream` runs on the Node path.
- **Verified for Sprint 3:** `resumeStream(resumeData,{runId,toolCallId?})` + `tool-call-suspended` (`payload.suspendPayload`) exist on `@mastra/core@1.41.0`; `runId` on the stream output.

---

## 11. Closeout

- [x] Sprint-2 commits on `v2` (`415f762`, `c683d75`, `cec822f`).
- [x] Phase B review — Approve (`review-sprint.md`); no fix-pass.
- [x] No deploy (Mastra is Node-only by design — documented).
- [x] `sprints/sprint-2/HANDOFF.md` written; `sprints/STATE.md` advanced to Sprint 3.
- [x] Backlog deltas (KI-2-01, KI-2-02) noted.

Sprint 2 is closed.
