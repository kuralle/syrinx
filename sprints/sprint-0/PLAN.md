# Sprint 0 — Plan

**Sprint name:** Ledger core (C1)
**Sprint goal (one sentence):** `IncrementalUnit` + `InMemoryIuLedger` exist in `packages/core`, dormant, with a monotonic/idempotent state machine proven by unit tests and green CI.
**Sprint window:** 2026-07-09 → (single-session build)
**Author (main session):** Opus 4.8 (1M) manager, 2026-07-09

---

## 0. Story consolidation (manager decision)

The WBS lists Sprint 0 as three stories (S0-01 types, S0-02 ledger+tests, S0-03 bench+README). They are **one cohesive file-pair** — the types are inert without the ledger, and the ledger cannot be tested without both. Splitting them into three IC contexts adds handoff overhead for zero independence benefit (the WBS "each story ships independently" test fails here: the types alone ship nothing). **Decision:** brief Sprint 0 as a single IC story `S0-01 — IU ledger core`, committed atomically as `[S0-01]`. S0-02/S0-03's acceptance criteria are folded in as criteria 2–7 below. This is logged in `runs/iu-substrate-implementation-notes.md`.

---

## 1. Stories

### `S0-01` — IU ledger core (`IncrementalUnit` + `InMemoryIuLedger`)

**Description:** Create the substrate the whole RFC sits on: the `IncrementalUnit` identity/state types (RFC §4.1) and the `IuLedger` interface + `InMemoryIuLedger` implementation (RFC §4.2, §7). Synchronous, in-memory, per-`contextId`. Monotonic state machine (`hypothesized → committed` or `hypothesized → revoked`; no un-commit), idempotent terminal ops, O(1) per op. Ships **dormant** — no consumer wired this sprint (consumers are C2–C4 in later sprints). Exported from `@kuralle-syrinx/core`.

**Acceptance criteria** (numbered, in priority order):
1. `packages/core/src/incremental-unit.ts` defines `IuState`, `IncrementalUnitId`, `IncrementalUnit` **exactly** per RFC §4.1 (see brief §4). Exported from `packages/core/src/index.ts`.
2. `packages/core/src/iu-ledger.ts` defines the `IuLedger` interface (RFC §4.2) and `InMemoryIuLedger` (RFC §7) with `add / commit / revoke / get / latest / clear`. Exported from index.
3. State machine is **monotonic**: `commit`/`revoke` only act on a `hypothesized` IU; acting on an already-terminal (`committed`/`revoked`) IU is a **no-op** (idempotent).
4. `commit`/`revoke`/`get` of an **unknown** `iuId` is **fail-open** (no throw; no-op / `undefined`). Both anomaly classes (terminal-op no-op, unknown-id) are surfaced through an **optional** constructor `onEvent?(evt)` hook (defaults to no-op) so a future consumer can observe them without the ledger importing the bus (keeps §12 Q2 "standalone, testable in isolation").
5. `commit(id, prefix?)` records the optional `committedPrefix` ({ chars?, ms? }). `latest(contextId, kind)` returns the most-recently-added IU of that kind for that ctx. `clear(contextId)` wipes exactly one ctx (per-ctx isolation).
6. `iu-ledger.test.ts` proves: monotonic transitions; idempotent terminal ops (+ `onEvent` fires); unknown-id fail-open; per-ctx isolation (`clear` on ctx A leaves ctx B intact); `latest` returns newest; `committedPrefix` recorded. At least one happy-path and one failure-path test per public method.
7. An O(1) assertion (a bench-style test: op cost independent of the number of contexts / IUs already in the ledger) + a short `packages/core/README` paragraph documenting the IU vocabulary and that the ledger is dormant until C2. `pnpm --filter @kuralle-syrinx/core typecheck && pnpm --filter @kuralle-syrinx/core test` green; workspace typecheck no worse than baseline.

**Files expected to be created or modified:**
- `packages/core/src/incremental-unit.ts` (create)
- `packages/core/src/iu-ledger.ts` (create)
- `packages/core/src/iu-ledger.test.ts` (create)
- `packages/core/src/index.ts` (modify — add exports)
- `packages/core/README.md` (modify — one paragraph)

**Test fixtures the worker will add:** none external — the ledger is pure; fixtures are inline IU objects built in the test.

**Demo artifact:** `sprints/sprint-0/artifacts/s0-01.txt` — captured `pnpm --filter @kuralle-syrinx/core test` output showing `iu-ledger.test.ts` green (state machine + idempotency + isolation + O(1)).

---

## 2. Universal DoD checklist (per story)

- [ ] Behavioral coverage: every public method tested with ≥1 happy-path and ≥1 failure-path test.
- [ ] Proof JSON written (`.handoff/proof-s0-01.json`); manager proceed evidence = **PROCEED**.
- [ ] Demo artifact attached (`sprints/sprint-0/artifacts/s0-01.txt`).
- [ ] No `--no-verify`, no `@ts-ignore`, no `as any`, no silent catch.
- [ ] House style matched: SPDX header, `.js` import extensions (NodeNext), `readonly` where the RFC types say so, `strict` + `noUncheckedIndexedAccess` clean.

---

## 3. Test plan

| Story | Layer | Test type | Fixtures |
|-------|-------|-----------|----------|
| S0-01 | unit | state-machine monotonicity + idempotency (`iu-ledger.test.ts`) | inline IU objects |
| S0-01 | unit | per-ctx isolation (`clear`, `latest`) | inline IU objects across 2 ctx |
| S0-01 | unit | fail-open on unknown id + `onEvent` anomaly hook | inline + spy |
| S0-01 | unit | O(1) op cost (bench-style assertion) | loop-built ledger |

What we will NOT test this sprint, and why each is safe:
- No consumer/integration tests — the ledger is dormant; consumers (speculative, barge-in, deepgram/tts) arrive in Sprints 2–4 and bring their own tests.
- No latency smoke — nothing on the hot path uses the ledger yet; REQ-6 no-regression is proven in Sprints 2–4 when it is wired.

---

## 4. Demo plan

**Demo:** captured terminal output of `pnpm --filter @kuralle-syrinx/core test` at sprint end, showing `iu-ledger.test.ts` green with the state-machine, idempotency, isolation, and O(1) cases, saved to `sprints/sprint-0/artifacts/s0-01.txt`.

---

## 5. Risks specific to this sprint

| Risk | Detection signal | Mitigation |
|------|------------------|------------|
| Over-abstraction — building ledger machinery no consumer needs | Anything outside the two new files + index/README changes | Ledger ships dormant; brief anti-scope forbids touching consumers this sprint. |
| Ledger couples to the bus to emit the "debug/llm.error" event | An import of `pipeline-bus`/`packets` in `iu-ledger.ts` | Optional `onEvent?` hook instead (manager decision, criterion 4); keep the ledger pure per §12 Q2. |
| Signature drift from RFC §4.1/§4.2 | Public surface differs from the RFC | Criterion 1–2 pin the types verbatim; proceed evidence diffs them against §4. |

---

## 6. Open questions

- **OQ-S0-1 (resolved by manager):** how does a pure, bus-free ledger surface the idempotent-noop "debug event" and unknown-id "llm.error" the RFC §4.2 names? → Optional constructor `onEvent?(evt: IuLedgerEvent)` hook, default no-op; consumers wire it to the bus in C2+. Ledger stays standalone/testable (§12 Q2). No blocker.
