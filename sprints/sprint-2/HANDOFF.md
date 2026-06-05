# Handoff — Sprint 2 → Sprint 3

> **One page. Read this before doing anything else.** Depth in [`WARMDOWN.md`](./WARMDOWN.md).

---

## State of the world (one paragraph)

Sprint 2 (Mastra adapter) is complete. `@asyncdot/voice-bridge-mastra` ships `fromMastraAgent(agent) → Reasoner`, verified against `@mastra/core@1.41.0` and structurally identical to `fromAiSdkAgent` (maps `output.fullStream` `{type,payload}` chunks; no callback queue). A real OpenAI-backed Mastra `Agent` drives the **unchanged** `ReasoningBridge` on the Node path, and a live STT→Mastra-LLM→TTS turn runs within the S1-00 latency band — proving the seam generalizes to a second backend with zero pipeline change. `@mastra/core` (201 deps) is Node-only: the deployed CF worker stays AI-SDK-backed and the edge bundle is Mastra-free. The RFC is amended to v2.2 (the verified Mastra mechanism). Sprint 3 adds the suspend/resume DO path — where the `tool-call-suspended`/`resumeStream` markers the Mastra adapter left come into play.

---

## Sprint 3 goal (verbatim from WBS)

**A Mastra workflow `suspend()` parks a run that is persisted by `runId` in the Durable Object, asked of the user, and resumed on a later voice turn — surviving DO hibernation between turns (proven in workerd).**

Full section: `sprints/WBS.md` § Sprint 3 (stories S3-01…S3-04).

---

## Read these first (in this order, before delegating any story)

1. `sprints/STATE.md` — active sprint + load-bearing list.
2. `sprints/WBS.md` § Sprint 3.
3. `sprints/sprint-2/WARMDOWN.md` §10 — the suspend/resume traps + verified Mastra API.
4. `docs/rfc-reasoner-bridge.md` §4.6 (suspend/resume across turns + DO `runId` + **(B4)** `onResumeConflict`), §9, §8 commits 3.1–3.5.
5. `packages/voice/src/reasoner.ts` — `ReasoningPart.suspended` + `ReasonerTurn.resume` (exist from S0-01).
6. `packages/voice-bridge-mastra/src/from-mastra.ts` — the `// Sprint 3 (S3-02)` marker (map `tool-call-suspended` → terminal `suspended`; route `turn.resume` → `agent.resumeStream(data,{runId})`).
7. `packages/voice-server-workers/src/*` — the DO + `DurableObjectSessionStore` (mirror for `DurableObjectRunStore` on `ctx.storage.sql`).
8. `packages/voice-bridge-aisdk/src/index.ts` — `ReasoningBridge` (add `suspended` handling + `onResumeConflict` + the injected `RunStore`).

**Run `/code-understand` on the DO + `ReasoningBridge` suspend path before briefing S3-03/S3-04** — the kickoff flags Sprint 3's DO path as warranting it. Link `.understanding/<slug>.md` in the briefs.

---

## Traps to know about

- **(B4) Spoken-prefix reconciliation on resume** — the one genuinely subtle correctness issue. If a barge-in correction landed on the conversation since a run suspended, `resumeStream` would restore Mastra's *uncorrected* checkpoint, diverging from the bridge's corrected history. `onResumeConflict` default **`restart`**: discard the run + re-ask with corrected `messages`. `replay` is opt-in. Test `suspend→barge-in→resume → restart`.
- **DO hibernation:** the `{runId, contextId, payload}` row must survive the DO being evicted between turns (workerd/Miniflare test). Mirror `DurableObjectSessionStore`; alarm-GC stale rows (TTL).
- **Edge stays Mastra-free:** the `DurableObjectRunStore` is **edge code** (SQL on `ctx.storage.sql`) — Mastra-free; the Mastra `resumeStream` runs on the Node path. Don't let `@mastra/core` leak into the DO/worker.
- **Latency:** suspend must add **no** latency to non-suspending turns (§7a gate — short fixture `SYRINX_WS_MAX_TURNS=1` vs the S1-00 band).
- **Verified:** `resumeStream(resumeData,{runId,toolCallId?})` + `tool-call-suspended` (`payload.suspendPayload`) + `runId` exist on `@mastra/core@1.41.0`.

---

## Open issues that block sprint 3

No open blockers. (KI-2-01 smartpbx flake is pre-existing/backlog; KI-2-02 tool parity is a nit.)

---

## Start by running

```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx && cat sprints/STATE.md && git branch --show-current && pnpm -r typecheck && pnpm --filter @asyncdot/voice-bridge-mastra test
```
(For `pnpm -r test`, note KI-2-01: re-run `voice-server-websocket` in isolation if the smartpbx heartbeat test flakes under load.)

---

## When you're done

Long-running managed program: advance to Sprint 3 (Step 4) without a fresh paste. New session resumes by pasting `sprints/SESSION_KICKOFF_PROMPT.md` + reading `sprints/STATE.md` + this HANDOFF.
