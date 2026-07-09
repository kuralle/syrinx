# Story Brief — `S0-01` IU ledger core

> **You are the IC engineer (`grok` worker — fresh process, clean context window, no prior context).** This brief is self-contained. Read it end-to-end before writing any code. If anything here is ambiguous or contradicts what you find on disk, **stop and ask** rather than guess.
>
> **Atomic-commit policy:** when you finish, stage the files you create/modify and commit atomically with `[S0-01] IU ledger core` on the **active build branch** `plan/iu-substrate` (already checked out). Do NOT push. Do NOT checkout `main`. Do NOT make multiple commits. Manager handles proceed evidence, fix-pass, and closeout.
>
> **Proof policy:** before exiting, write `.handoff/proof-s0-01.json` (schema in §8). Manager verifies by re-running your commands — exit codes are authoritative.

---

## 1. Goal

Create the Incremental-Unit substrate: the `IncrementalUnit` identity/state types and the `IuLedger` interface + `InMemoryIuLedger` implementation in `packages/core`, dormant (no consumer wired), with a monotonic/idempotent state machine proven by unit tests and green `@kuralle-syrinx/core` typecheck + test.

---

## 2. Required reading (in this order)

1. `docs/rfc-incremental-unit-substrate.md` — **§3 (REQ-1,2,3,6), §4.1 (IU identity+state), §4.2 (IuLedger interface + behavior + error cases), §7 (code blueprint).** This is the contract. The signatures in §4 are authoritative.
2. `sprints/sprint-0/PLAN.md` § Story `S0-01` — the acceptance criteria you must pass (they expand this brief).
3. `sprints/WBS.md` § Sprint 0 — context.
4. House-style references (match these exactly):
   - `packages/core/src/reasoner-session-store.ts` — SPDX header, `interface` + `class implements`, `readonly` `Map`, `.js` import extensions, no external deps.
   - `packages/core/src/tts-playout-clock.test.ts` — vitest style (`import { describe, it, expect } from "vitest"`, `.js` import of the unit under test).
   - `packages/core/tsconfig.json` — `strict` + `noUncheckedIndexedAccess` + `NodeNext`. Your code must be clean under these (note: `noUncheckedIndexedAccess` means indexed/Map reads are `T | undefined` — handle it, do not `!`-assert or `as`).

---

## 3. Files you will create or modify

**Create:**
- `packages/core/src/incremental-unit.ts` — the IU identity + state types (§4.1).
- `packages/core/src/iu-ledger.ts` — `IuLedger` interface + `InMemoryIuLedger` class (§4.2, §7).
- `packages/core/src/iu-ledger.test.ts` — vitest unit tests (see §4 acceptance).

**Modify:**
- `packages/core/src/index.ts` — export the new public types + `InMemoryIuLedger` (+ `IuLedger` type). Add near the reasoner/store exports, matching the existing export-grouping comment style.
- `packages/core/README.md` — add one short paragraph: the IU vocabulary (add/commit/revoke = hypothesize/ground/discard) and that the ledger is **dormant** (no consumer until C2). Do not restructure the README.

**Do not touch anything else.** Not the RFC, not other packages, not `sprints/` (the manager owns those). Proceed evidence will reject a diff that touches files outside this list.

---

## 4. Exact interface (from RFC §4.1 / §4.2 — implement verbatim)

`incremental-unit.ts`:
```ts
export type IuState = "hypothesized" | "committed" | "revoked";
export interface IncrementalUnitId {
  readonly contextId: string;
  readonly iuId: string;
  readonly epoch: number;
}
export interface IncrementalUnit {
  readonly id: IncrementalUnitId;
  readonly kind: "user_turn" | "assistant_response" | "tts_segment";
  state: IuState;
  /** For assistant/tts IUs: the committed character/ms prefix (heard). */
  committedPrefix?: { chars?: number; ms?: number };
}
```

`iu-ledger.ts`:
```ts
export interface IuLedger {
  add(iu: IncrementalUnit): void;                                   // register a hypothesis
  commit(id: IncrementalUnitId, prefix?: { chars?: number; ms?: number }): void;
  revoke(id: IncrementalUnitId): void;
  get(id: IncrementalUnitId): IncrementalUnit | undefined;
  latest(contextId: string, kind: IncrementalUnit["kind"]): IncrementalUnit | undefined;
  clear(contextId: string): void;                                   // on transport close only
}
```

**Behavior (RFC §4.2 + §7):**
- Synchronous, in-memory, per-`contextId`. Internal shape: `Map<contextId, Map<iuId, IncrementalUnit>>` (mirror `InMemoryReasonerSessionStore`'s `readonly` Map field).
- `add`: register the IU under its ctx+iuId. If the same iuId is added again for a ctx, the latest add wins (overwrite) — `add` is for a fresh hypothesis.
- `commit(id, prefix?)`: if the IU exists **and** is `hypothesized`, set `state="committed"` and (if `prefix` given) set `committedPrefix`. If it is already terminal (`committed`/`revoked`) → **no-op** (idempotent) and emit an `onEvent` anomaly (see below). If unknown iuId → **no-op**, emit anomaly, do not throw (fail-open).
- `revoke(id)`: symmetric — `hypothesized → revoked`; terminal → no-op + anomaly; unknown → no-op + anomaly.
- `get(id)`: return the IU or `undefined` (unknown → `undefined`, no throw).
- `latest(contextId, kind)`: the most-recently-`add`ed IU of that `kind` in that ctx, or `undefined`. Track insertion order (a JS `Map` preserves insertion order — iterate for the last matching kind, or keep a small per-ctx ordering).
- `clear(contextId)`: delete exactly that ctx's map. Other ctxs untouched.
- **Never throws on the hot path; O(1) amortized** for add/commit/revoke/get (`latest` may be O(n-in-ctx) — that is fine).

**The `onEvent` anomaly hook (manager design decision — resolves RFC §4.2 "debug event" / "recoverable llm.error" without coupling the pure ledger to the bus, keeping §12 Q2 "standalone, testable in isolation"):**
```ts
export type IuLedgerAnomaly =
  | { readonly kind: "terminal_op"; readonly op: "commit" | "revoke"; readonly id: IncrementalUnitId; readonly state: IuState }
  | { readonly kind: "unknown_iu"; readonly op: "commit" | "revoke"; readonly id: IncrementalUnitId };

export class InMemoryIuLedger implements IuLedger {
  constructor(private readonly onEvent: (a: IuLedgerAnomaly) => void = () => {}) {}
  // ...
}
```
The default no-op keeps the ledger silent and dependency-free. A consumer (C2+) will pass a hook that pushes an `iu_ledger` debug/`llm.error` packet — **not this sprint**.

---

## 5. Acceptance criteria (numbered, priority order — pass all before committing)

1. The two new files define the types/classes **exactly** as §4 above; `index.ts` exports `IuState`, `IncrementalUnitId`, `IncrementalUnit`, `IuLedger`, `IuLedgerAnomaly`, `InMemoryIuLedger`.
2. `pnpm --filter @kuralle-syrinx/core typecheck` exits 0 (clean under `strict` + `noUncheckedIndexedAccess` — no `!`, no `as any`, no `@ts-ignore`).
3. `iu-ledger.test.ts` (vitest) proves, each with ≥1 happy + ≥1 failure path:
   - monotonic transitions: `add` → `hypothesized`; `commit` → `committed`; `revoke` → `revoked`; **cannot** un-commit (commit-then-revoke leaves it `committed`, revoke was a no-op, anomaly fired).
   - idempotent terminal ops: second `commit`/`revoke` is a no-op **and** fires an `onEvent` `terminal_op` anomaly (assert via an injected spy).
   - unknown-id: `commit`/`revoke`/`get` of an id never `add`ed does not throw; `get` → `undefined`; `commit`/`revoke` fire an `unknown_iu` anomaly.
   - per-ctx isolation: `clear("A")` leaves ctx `"B"`'s IUs intact.
   - `latest(ctx, kind)`: returns the newest added IU of that kind; `undefined` when none.
   - `committedPrefix`: `commit(id, { ms: 800, chars: 40 })` records the prefix on the IU.
4. O(1) assertion: a test that builds N contexts/IUs (e.g. N=10 and N=1000) and asserts a single `commit`/`get` does constant work — assert by invariant (op touches only its ctx map), not wall-clock timing (timing is flaky). E.g. spy/counter on map lookups, or simply assert correctness + document O(1) in a comment; a coarse `performance.now()` ratio is acceptable only if it has a wide margin. Prefer the structural assertion.
5. `pnpm --filter @kuralle-syrinx/core test` exits 0 (all core tests, including yours, green).
6. `packages/core/README.md` has the one-paragraph IU/dormant note.

---

## 6. What NOT to do (anti-scope — proceed evidence rejects these)

- Do not wire the ledger into any consumer (speculative path, barge-in, deepgram, tts) — that is Sprints 2–4.
- Do not import `pipeline-bus`, `packets`, or anything else into `iu-ledger.ts` — it stays dependency-free (the `onEvent` hook is the seam).
- Do not refactor, reformat, or "improve" adjacent code. Do not touch other packages.
- Do not add dependencies. `packages/core` has zero runtime deps — keep it so.
- Do not rewrite existing tests. Only add `iu-ledger.test.ts`.
- Do not touch `sprints/`, `docs/`, or `research/`.
- No `--no-verify`, no `@ts-ignore`, no `as any`, no silent `try/catch`.

---

## 7. Demo artifact

Save the captured output of `pnpm --filter @kuralle-syrinx/core test` (the run showing your tests green) to `sprints/sprint-0/artifacts/s0-01.txt`. Reference it in your commit body.

---

## 8. Proof commands + validation contract

**Slug:** `s0-01` → `.handoff/proof-s0-01.json`

**Assertions (from RFC §9.0):**

| ID | Description |
|----|-------------|
| REQ-1 | IU identity: every turn-scoped IU carries `{contextId, iuId, epoch}` (type exists + exported) |
| REQ-2 | State transitions monotonic; terminal ops idempotent (unit) |
| REQ-3 | Single ledger records IU state per contextId (`InMemoryIuLedger`) |
| REQ-6 | Ledger in-memory + synchronous; per-op O(1) (structural assertion) |
| test:iu-ledger | ledger state machine + idempotency + per-ctx isolation green |

**Commands to run** (each must appear in `commands_run[]` with its exit code):
```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
pnpm --filter @kuralle-syrinx/core typecheck
pnpm --filter @kuralle-syrinx/core test
```

**Proof JSON shape** (`.handoff/proof-s0-01.json`):
```json
{
  "slug": "s0-01",
  "branch": "plan/iu-substrate",
  "commit": "<sha of your [S0-01] commit>",
  "commands_run": [
    { "cmd": "pnpm --filter @kuralle-syrinx/core typecheck", "exit": 0 },
    { "cmd": "pnpm --filter @kuralle-syrinx/core test", "exit": 0 }
  ],
  "files_changed": ["packages/core/src/incremental-unit.ts", "packages/core/src/iu-ledger.ts", "packages/core/src/iu-ledger.test.ts", "packages/core/src/index.ts", "packages/core/README.md"],
  "satisfies_assertions": ["REQ-1", "REQ-2", "REQ-3", "REQ-6", "test:iu-ledger"],
  "demo_artifact": "sprints/sprint-0/artifacts/s0-01.txt",
  "notes": "<anything the manager should know — deviations, decisions, what you could not verify>"
}
```

---

## 9. How to report back

1. Commit atomically: `[S0-01] IU ledger core` on `plan/iu-substrate`.
2. Write `.handoff/proof-s0-01.json`.
3. Ensure `sprints/sprint-0/artifacts/s0-01.txt` exists.
4. Exit. Do NOT open a PR — the manager collects proceed evidence.

---

## 10. If you get stuck

- If a referenced file/symbol does not exist: stop, report what you found vs expected.
- If acceptance criteria contradict the RFC: stop, report.
- If a dependency conflict appears: stop — do not downgrade or override.

Sincere work is the only kind we ship. If you didn't run a command, say so in `notes`. If you couldn't verify something, say so.
