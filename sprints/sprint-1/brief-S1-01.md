# Story Brief — `S1-01` Speculative-on-ledger + identity producer

> **You are the IC engineer (`grok` worker — fresh process, clean context, no prior context).** Self-contained brief; read it fully before writing code. If anything is ambiguous or contradicts disk, **stop and ask** (write `.handoff/blocked-s1-01.md`).
>
> **Atomic-commit policy:** commit once, atomically: `[S1-01] Speculative-on-ledger + identity producer` on the checked-out branch `plan/iu-substrate`. Do NOT push, do NOT checkout `main`, do NOT multi-commit.
>
> **Proof policy:** before exiting, write `.handoff/proof-s1-01.json` (schema in §8).
>
> **HARD ABORT (RFC §11):** this is a **behavior-preserving** re-expression. If you cannot make the 4 existing speculative tests pass **without editing their assertions**, STOP and write `.handoff/blocked-s1-01.md` explaining the divergence. Do not force equivalence, do not edit the existing tests, do not `@ts-ignore`.

---

## 1. Goal

Re-express the ReasoningBridge speculative path on the S0 `InMemoryIuLedger` (`@kuralle-syrinx/core`) as its first consumer — **with no behavior change** — moving `SpeculativeHold`'s commit *state* into the ledger while keeping its side-effect buffer, and stamping each turn with a first-class `IncrementalUnitId {contextId, iuId, epoch}`.

---

## 2. Required reading (in this order)

1. `docs/rfc-incremental-unit-substrate.md` §8 C2, §2.2, §6 (the speculative→ledger mapping), §7.
2. `docs/rfc-incremental-unit-substrate-amendment-C5.md` §4 (why C2 also carries the identity producer).
3. `sprints/sprint-1/PLAN.md` §0 (manager decision **D-4** — what moves to the ledger vs what stays) and §1 (acceptance).
4. `packages/core/src/iu-ledger.ts` + `incremental-unit.ts` — the S0 ledger you consume: `InMemoryIuLedger`, `IuLedger`, `IncrementalUnit`, `IncrementalUnitId`, `IuLedgerAnomaly`. Note the constructor takes an optional `onEvent(a: IuLedgerAnomaly)`.
5. `packages/aisdk/src/index.ts` — the file you modify. Read **lines 50-300** in full: `SpeculativeHold` (`:62-66`), `speculativeDraft` field (`:75-80`), the `eos.turn_complete` promote/discard logic (`:156-179`), `runDraft` (`:241-247`), `discardDraft` (`:249-254`), `processTurn` + the `push`/`defer` gate (`:256-287`), the `eos.interim`/`eos.retracted` handlers (`:224-237`), `interrupt.llm` (`:210-221`).
6. `packages/aisdk/src/index.test.ts` — the **4 speculative tests you must keep green unchanged**: `:809` (buffers on interim, flushes on matching turn_complete), `:848` (discards on retracted — nothing ever pushed), `:880` (regenerates when confirmed differs), `:912` (ignores interim when speculative off). Read them so you know the exact behavior contract.
7. `packages/core/src/packets.ts` — find `LlmErrorPacket` (its exact fields) for the `onEvent` wiring in §4.

---

## 3. The design (manager decision D-4 — implement exactly this)

`SpeculativeHold` today (`:62-66`) fuses **state** (`promoted`, `failed`) and a **side-effect buffer** (`buffered`). Move the state to the ledger; keep the buffer.

**3a. Add the ledger + epoch producer to `ReasoningBridge`:**
- New private field: `private readonly iuLedger: InMemoryIuLedger` — construct it in `initialize` (after `this.bus` is set) with an `onEvent` that pushes an `iu_ledger` anomaly packet (see §4). (Constructing in `initialize` lets `onEvent` close over `this.bus`.)
- New private field: `private readonly epochByContext = new Map<string, number>();` and `private turnEpochCounter = 0;`.
- Helper `private iuIdFor(contextId: string): IncrementalUnitId`: if `epochByContext` has no entry for `contextId`, assign `this.epochByContext.set(contextId, ++this.turnEpochCounter)`. Return `{ contextId, iuId: contextId, epoch: this.epochByContext.get(contextId)! }`. (One `user_turn` IU per contextId; `iuId === contextId` because there is one user turn per contextId. `epoch` is monotonic per new turn — no consumer reads ordering yet, monotonic is the only requirement.)

**3b. Shrink `SpeculativeHold` to just the buffer:**
```ts
interface SpeculativeHold {
  buffered: Array<() => void>;
}
```
Remove `promoted` and `failed`. Everywhere they were read, read ledger state instead (below).

**3c. Rewire the state reads/writes to the ledger** (keep every other line of behavior identical):
- `runDraft` (`:241`): after `discardDraft()`, build `const id = this.iuIdFor(contextId)` and `this.iuLedger.add({ id, kind: "user_turn", state: "hypothesized" })`. Store `id` on the `speculativeDraft` object (add an `id: IncrementalUnitId` field) so promote/discard can reference it. `hold = { buffered: [] }`.
- Promote path (`:162-174`, the matching `eos.turn_complete`): replace `draft.hold.promoted = true` with `this.iuLedger.commit(draft.id)`. Keep `for (const flush of draft.hold.buffered.splice(0)) flush();`. The guard `!draft.hold.failed` (`:168`) becomes `this.iuLedger.get(draft.id)?.state === "hypothesized"` (a failed draft was revoked → not hypothesized → won't promote, matching today).
- `discardDraft` (`:249`): replace `if (!draft.hold.promoted) draft.controller.abort()` with `const committed = this.iuLedger.get(draft.id)?.state === "committed"; if (!committed) { this.iuLedger.revoke(draft.id); draft.controller.abort(); }`. (Revoke the still-hypothesized draft; a promoted/committed one is left committed and not aborted — identical to today.)
- The `push` gate (`:276-283`): `if (hold && !hold.promoted)` becomes `if (hold && this.iuLedger.get(draftId)?.state !== "committed")` — you'll need the draft's `id` in scope. The cleanest is to pass the `IncrementalUnitId` into `processTurn` alongside `hold` (add a param), or read it from `this.speculativeDraft?.id` when `hold` is the current draft's hold. **Preserve the exact semantics:** buffer while not committed, flush on commit. On an `llm.error` while held (`:278` sets `hold.failed = true` today) → instead `this.iuLedger.revoke(id)` (marks the draft failed = revoked; the promote guard then won't promote it). Keep buffering the error packet.
- `eos.retracted` (`:232-235`) and `interrupt.llm` (`:210-221`): they call `discardDraft()`, which now revokes — no extra change needed beyond 3c's `discardDraft`.

**Net:** `promoted` → `ledger.state === "committed"`; `failed` → `ledger.revoke` (state becomes `"revoked"`); `buffered` stays. No dual bookkeeping — the booleans are gone.

---

## 4. The `onEvent` anomaly packet (first real use of the S0 hook)

Do **not** invent a new packet. Reuse the existing `llm.error` shape (read `LlmErrorPacket` in `packets.ts`) with a component tag:
- In `initialize`, construct: `this.iuLedger = new InMemoryIuLedger((a) => { this.bus?.push(Route.Background, <LlmErrorPacket with component:"iu_ledger", a recoverable/non-fatal error describing a.kind + a.op + a.id.contextId, timestampMs: Date.now(), contextId: a.id.contextId>); });`
- Match the exact `LlmErrorPacket` field names you find in `packets.ts` (e.g. `kind: "llm.error"`, `component`, `message`, `recoverable`/`fatal`, `contextId`, `timestampMs`). It must be **recoverable/non-fatal** — an anomaly, not a turn-killer. Route `Background`.

---

## 5. Acceptance criteria (pass ALL before committing)

1. The 4 existing speculative tests (`index.test.ts:809,848,880,912`) pass **unchanged** — you did not edit their assertions.
2. `SpeculativeHold` no longer has `promoted`/`failed`; draft state comes from `this.iuLedger`.
3. `eos.interim`→`add`, promote→`commit`, discard/retract/interrupt/llm-error→`revoke` all wired; `buffered[]` retained.
4. `onEvent` pushes a recoverable `iu_ledger`-tagged `llm.error` on the bus (Background).
5. New `packages/aisdk/src/speculative-on-ledger.test.ts`: (happy) interim→add creates a hypothesized IU, matching turn_complete commits it; (happy) retracted revokes it; (failure) a double-commit fires an `onEvent` anomaly (inject a spy ledger OR assert the bus gets the iu_ledger packet); (identity) the IU id carries a monotonic `epoch` that increments across two distinct-contextId turns.
6. `pnpm --filter @kuralle-syrinx/aisdk typecheck` exit 0 (strict + `noUncheckedIndexedAccess` — the `epochByContext.get(...)!` is the one place a `!` is defensible right after a `set`; prefer a local const to avoid it).
7. `pnpm --filter @kuralle-syrinx/aisdk test` exit 0 (all aisdk tests green).

---

## 6. What NOT to do (anti-scope — proceed evidence rejects these)

- Do NOT edit the 4 existing speculative tests' assertions. Do NOT edit any other existing test.
- Do NOT touch leaf STT/TTS plugins, transports, `voice-agent-session.ts`, or `contextId` minting. `contextId` semantics are unchanged; leaf plugins are Sprint 3 (C4).
- Do NOT do the full `{contextId,iuId,epoch}` reshape across packets/consumers — that is deferred backlog B-05. You only add IU ids inside the aisdk bridge.
- Do NOT invent a new packet kind — reuse `llm.error` with `component:"iu_ledger"`.
- Do NOT keep the old `promoted`/`failed` booleans alongside the ledger (no dual bookkeeping).
- No `--no-verify`, `@ts-ignore`, `as any`, or silent catch.

---

## 7. Demo artifact

Save `pnpm --filter @kuralle-syrinx/aisdk test` output (showing the 4 unchanged + your new test green) to `sprints/sprint-1/artifacts/s1-01.txt`. Reference it in the commit body.

---

## 8. Proof commands + validation contract

**Slug:** `s1-01` → `.handoff/proof-s1-01.json`

| ID | Description |
|----|-------------|
| REQ-5 | speculative + barge-in re-expression behavior-preserving (4 tests unchanged) |
| REQ-3 | single ledger records IU state (bridge consumes `IuLedger`) |
| test:speculative-unchanged | the 4 existing speculative tests green, assertions unedited |
| test:speculative-on-ledger | new test: commit/revoke mapping + epoch + onEvent |

**Commands (each in `commands_run[]` with exit code):**
```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
pnpm --filter @kuralle-syrinx/aisdk typecheck
pnpm --filter @kuralle-syrinx/aisdk test
```

**Proof JSON** (`.handoff/proof-s1-01.json`): `{ slug, branch:"plan/iu-substrate", commit:"<sha>", commands_run:[{cmd,exit}], files_changed:[...], satisfies_assertions:["REQ-5","REQ-3","test:speculative-unchanged","test:speculative-on-ledger"], demo_artifact:"sprints/sprint-1/artifacts/s1-01.txt", notes:"<decisions / anything unverified>" }`.

---

## 9. Report back

1. Commit `[S1-01] Speculative-on-ledger + identity producer`.
2. Write `.handoff/proof-s1-01.json`.
3. Ensure `sprints/sprint-1/artifacts/s1-01.txt` exists.
4. Exit — no PR.

---

## 10. If you get stuck

- A referenced symbol/line differs from disk → stop, report what you found.
- A speculative test cannot be kept green without editing it → **STOP**, write `.handoff/blocked-s1-01.md` with the exact divergence (which test, expected vs actual, your hypothesis). This is the RFC §11 abort — the manager triages, do not patch around it.
- Dependency conflict → stop, do not downgrade.

Sincere work only. If you didn't run a command, say so in `notes`.
