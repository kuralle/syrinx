# Story Brief — `S2-01` Assistant-side IU producer + heard-prefix commit (C3)

> **You are the IC engineer (`grok` worker — fresh process, clean context).** Self-contained brief. If anything is ambiguous or contradicts disk, **stop** (`.handoff/blocked-s2-01.md`).
>
> **Commit:** one atomic `[S2-01] Assistant-side IU producer + heard-prefix commit` on `plan/iu-substrate`. No push, no `main`.
> **Proof:** `.handoff/proof-s2-01.json` (§8).
> **HARD ABORT (RFC §11):** **behavior-preserving.** The existing barge-in/history truncation must not change. If an existing test can only pass by editing it, STOP and write `.handoff/blocked-s2-01.md`.

---

## 1. Goal

Give the `IuLedger` an `assistant_response` IU per turn and record its **heard prefix** on barge-in — **re-expressing the already-wired heard-prefix truncation on the ledger**, adding nothing to the observable behavior. This is the assistant-side counterpart to S1's user-turn producer, and it feeds C4 (Sprint 3).

**Context (do not "fix" this — it already works):** `computeSpokenPrefix` (`packages/aisdk/src/index.ts:578`) already computes the heard prefix (word-boundary via `w.endMs <= playedOutMs`, else `spokenByContext` fallback), and `commitInterruptedHistory` (:598) + `rememberTurn` (:551) already rewrite/persist history. You only ADD ledger `add`/`commit`/`revoke` calls alongside.

---

## 2. Required reading

1. `docs/rfc-incremental-unit-substrate.md` §8 C3, §4.3 (`interrupt.tts` → commit-heard-then-revoke), §6 (pseudocode), REQ-4.
2. `sprints/sprint-2/PLAN.md` (acceptance + the resolved OQ on "revoke the remainder").
3. `sprints/WBS.md` § Sprint 2 (the D-5 premise correction).
4. `packages/aisdk/src/index.ts` — read: the S1 producer `iuIdFor` (`:264`ish — the `epochByContext` helper), `runDraft`/`processTurn`, `rememberTurn` (:551), `commitInterruptedHistory` (:598), `computeSpokenPrefix` (:578), `clearTurnState`, and where the ledger + `epochByContext` fields live (added in S1).
5. `packages/core/src/incremental-unit.ts` — `IncrementalUnit` (`committedPrefix?: { chars?; ms? }`), `IuLedger.commit(id, prefix?)`.
6. `packages/aisdk/src/speculative-on-ledger.test.ts` — the S1 test style for asserting ledger state via the `bridgeLedger` private-access helper.

---

## 3. Design (implement exactly)

**3a. Distinct assistant IU identity** (must not collide with S1's `user_turn` IU, which uses `iuId === contextId`):
```ts
private assistantIuIdFor(contextId: string): IncrementalUnitId {
  // reuse the SAME per-turn epoch as the user-turn IU (epochByContext is populated by iuIdFor;
  // if absent — e.g. a non-speculative turn that never ran iuIdFor — assign one the same way)
  let epoch = this.epochByContext.get(contextId);
  if (epoch === undefined) { epoch = ++this.turnEpochCounter; this.epochByContext.set(contextId, epoch); }
  return { contextId, iuId: `${contextId}#assistant`, epoch };
}
```

**3b. Lifecycle wiring** (add these ledger calls; change nothing else):
- **Add (hypothesized)** — in `processTurn`, at the point the generation is committed to run (right after `this.activeGeneration = { contextId, controller }`). `const aid = this.assistantIuIdFor(contextId); this.iuLedger.add({ id: aid, kind: "assistant_response", state: "hypothesized" });`
  - Idempotency: `processTurn` can run again for the same contextId (speculative discard → fresh run). A re-`add` for the same `${contextId}#assistant` overwrites with a fresh hypothesized IU — that is correct (the prior generation was superseded). Fine.
- **Commit fully (clean completion)** — in `rememberTurn` (:551), after the assistant message is pushed: `this.iuLedger.commit(this.assistantIuIdFor(contextId));` (no prefix = fully heard).
- **Commit with heard prefix (barge-in)** — in `commitInterruptedHistory` (:598), after `const spoken = this.computeSpokenPrefix(contextId);`: 
  ```ts
  const ms = this.playedOutMsByContext.get(contextId);
  this.iuLedger.commit(this.assistantIuIdFor(contextId), { chars: spoken.length, ms });
  ```
  (The existing history rewrite below it — the "revoke the rest" — stays exactly as is. Do not add a separate revoke here; per PLAN OQ-S2-1 the truncation IS the remainder-revoke in turn granularity.)
- **Revoke (discarded/aborted without commit)** — in `clearTurnState(contextId)`: if the assistant IU exists and is still `hypothesized`, `this.iuLedger.revoke(this.assistantIuIdFor(contextId));` (so an aborted/superseded generation leaves a `revoked`, not a dangling `hypothesized`, IU). Guard with `this.iuLedger.get(...)?.state === "hypothesized"` to avoid a spurious anomaly on an already-committed IU.

**Note on `commit` idempotency:** the S0 ledger makes `commit` on an already-terminal IU a no-op + `onEvent` anomaly. Ensure the normal paths don't double-commit the assistant IU (commit-full in `rememberTurn` XOR commit-prefix in `commitInterruptedHistory` — a turn is either cleanly completed or barged-in, not both). If both could fire for one turn in some path, gate the second. Verify by reading the completion vs interrupt flow.

---

## 4. Acceptance criteria (pass ALL)

1. All existing aisdk tests (37) pass **unchanged** (no edits to their assertions).
2. New `packages/aisdk/src/heard-prefix-commit.test.ts`:
   - **word-boundary path:** feed `tts.word_timestamps` + `tts.playout_progress` so `computeSpokenPrefix` uses word boundaries; barge-in (`interrupt.llm`); assert the assistant IU is `committed` with `committedPrefix.chars === spoken.length` and `committedPrefix.ms === playedOutMs`, and `committedPrefix.chars` reflects only the heard words (not the full reply).
   - **ms-fallback path:** no word timestamps; barge-in; assert the assistant IU committed with the `spokenByContext`-based prefix.
   - **mid-stream interrupt:** interrupt while the generation is still streaming; assert the assistant IU commits the heard prefix (not the full reply), and no packets are lost (reuse the S1 gate-style harness if helpful).
   - **clean completion:** no barge-in; assert the assistant IU is `committed` with no truncated prefix.
   - **distinct identity:** assert the assistant IU (`${ctx}#assistant`) and the user-turn IU (`${ctx}`) coexist in the ledger for one contextId.
3. `pnpm --filter @kuralle-syrinx/aisdk typecheck` exit 0 (strict; no `@ts-ignore`/`as any` in production).
4. `pnpm --filter @kuralle-syrinx/aisdk test` exit 0.

---

## 5. What NOT to do
- Do NOT change `computeSpokenPrefix`, the history rewrite in `commitInterruptedHistory`/`rememberTurn`, or any existing test.
- Do NOT touch other packages, `voice-agent-session.ts`, transports, or `contextId` semantics.
- Do NOT reuse `iuId === contextId` for the assistant IU (it would overwrite the user-turn IU).
- No `--no-verify`, `@ts-ignore`, `as any` (production), silent catch.

---

## 6. Demo
Save `pnpm --filter @kuralle-syrinx/aisdk test` output to `sprints/sprint-2/artifacts/s2-01.txt`.

---

## 7. Proof + report
`.handoff/proof-s2-01.json`: `commands_run` = the two pnpm commands (exit 0); `satisfies_assertions` = `["REQ-4","test:heard-prefix-commit","test:existing-unchanged"]`; `files_changed`, `demo_artifact`, `notes`. Commit `[S2-01] Assistant-side IU producer + heard-prefix commit`. Exit — no PR.

---

## 8. If stuck
If an existing test can't stay green, or a turn double-commits the assistant IU and you can't cleanly gate it, STOP and write `.handoff/blocked-s2-01.md` with the exact path/flow. Do not paper over with `@ts-ignore` or a suppressed anomaly.

Sincere work only. Note anything unverified in `notes`.
