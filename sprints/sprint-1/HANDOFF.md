# Handoff — Sprint 1 → Sprint 2

> **One page. Read first.** Depth in [`WARMDOWN.md`](./WARMDOWN.md).

---

## State of the world (one paragraph)

Sprint 1 (C2 + identity producer) is complete. Speculative generation now runs on the `IuLedger` (behavior-preserving), the ledger has its first producer (a `user_turn` IU per turn with a monotonic `epoch`), and the S0 `onEvent` hook fires real `iu_ledger` anomalies. A HOLD caught a mid-stream-promotion regression, now fixed and locked by a permanent guard. Sprint 2 is C3 — wire the **assistant-side** heard-prefix commit on barge-in through the ledger.

---

## Sprint 2 goal (verbatim from WBS)

**On barge-in, history truncates to the heard prefix through `IuLedger.commit(prefix = heard)` — the specified-but-unwired guarantee, now wired for all transports and tested.**

Full section: `sprints/WBS.md` § Sprint 2.

---

## Read these first (in order)

1. `sprints/STATE.md` — active sprint + load-bearing list.
2. `sprints/WBS.md` § Sprint 2.
3. `docs/rfc-incremental-unit-substrate.md` §8 C3, §4.3 (`interrupt.tts` → commit-heard-then-revoke), §6, REQ-4.
4. `packages/aisdk/src/index.ts` — the barge-in path already exists: `interrupt.llm` handler → `commitInterruptedHistory(contextId)` (`:210-221`), and the heard-prefix precision ladder (`spokenByContext` / `wordTimestampsByContext` / `playedOutMsByContext`, `:83-102`). C3 wires `ledger.commit(assistantIu, prefix=heard)` here.
5. `packages/core/src/voice-agent-session.ts` — `interrupt.tts`, `handleTurnComplete`, the per-turn Sets.
6. `packages/core/src/tts-playout-clock.ts` — heard-ms source.

---

## Traps to know about

- **Two precision paths:** heard prefix = word-boundary (when `wordTimestampsByContext` + `playedOutMsByContext` present) else `spokenByContext` ms fallback. C3 must handle both — this is the RFC §11 symptom-patch stop (one commit boundary for all transports, not one special-case).
- **Assistant-side IU:** Sprint 1 produced `user_turn` IUs. C3 introduces the `assistant_response` IU and commits its *heard prefix*. Reuse `iuIdFor`-style identity (or add an assistant IU per turn).
- **Enumerate timing cases in the brief** (lesson from S1): barge-in during streaming vs after completion; interrupt before any TTS; word-boundary vs ms fallback. Write them as explicit acceptance criteria before delegating.
- `verify-handoff-proof.sh` still has the `KeyError: 'type'` schema drift — verify by re-running the worker's commands directly.

---

## Open issues that block sprint 2

No blockers. Baseline green except the known `examples/02` playwright-core failure.

---

## Start by running

```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx && git checkout plan/iu-substrate && cat sprints/STATE.md && pnpm --filter @kuralle-syrinx/aisdk test
```

---

## When you're done

Continue in the same session to Sprint 3 (migrate poison-sets → ledger, C4) per the kickoff Step 4.
