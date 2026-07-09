# Sprint 1 — Plan

**Sprint name:** Speculative on the ledger (C2) + first-class turn-identity producer
**Sprint goal (one sentence):** speculative generation re-expressed as an `IuLedger` consumer (behavior-preserving; `SpeculativeHold` private *state* gone), and the ledger gains its first producer — a `user_turn` IU per turn.
**Sprint window:** 2026-07-09 (single session)
**Author (main session):** Opus 4.8 (1M) manager, 2026-07-09
**Rescope:** per [`docs/rfc-incremental-unit-substrate-amendment-C5.md`](../../docs/rfc-incremental-unit-substrate-amendment-C5.md).

---

## 0. The design call the RFC glosses (manager decision D-4)

`SpeculativeHold` (`packages/aisdk/src/index.ts:62-66`) fuses two concerns:
1. **Commit state** — `promoted: boolean`, `failed: boolean`. This IS the ledger's job (`hypothesized → committed | revoked`).
2. **A side-effect buffer** — `buffered: Array<() => void>`. This is a delivery-gating *mechanism*, not identity; the ledger does not model it.

"Remove `SpeculativeHold` private state in favor of the ledger" (RFC C2) therefore means: **move (1) to the ledger, keep (2) as the mechanism.** After C2, the draft's state is read from `IuLedger`; the buffer remains as the queue that defers bus pushes until promotion. This is behavior-preserving and is the only faithful reading — collapsing the buffer into the ledger would break the side-effect gating (and thus the 4 characterization tests). Logged in `runs/iu-substrate-implementation-notes.md` D-4.

---

## 1. Stories

### `S1-01` — Speculative-on-ledger + identity producer

**Description:** Re-express the speculative path on the S0 `InMemoryIuLedger`. On `eos.interim` the bridge `add`s a `hypothesized` `user_turn` IU; on a matching `eos.turn_complete` it `commit`s (promote); on mismatch/`eos.retracted`/`interrupt.llm` it `revoke`s (discard). The `promoted`/`failed` booleans are replaced by ledger-state reads; the `buffered[]` queue stays. The ledger's `onEvent` hook (S0 D-1) is wired to push an `iu_ledger` debug/`llm.error` packet — its first real consumer. IU id = `{contextId, iuId: contextId, epoch}` with `epoch` a per-bridge monotonic counter assigned per turn.

**Acceptance criteria** (numbered, priority order):
1. The 4 existing speculative characterization tests (`index.test.ts:809,848,880,912`) pass **unchanged** (no edits to their assertions). This is the behavior-preservation gate (RFC §11 abort if one flips and cannot be made equivalent).
2. `SpeculativeHold.promoted` and `.failed` are removed; draft state is read from the ledger (`committed`/`revoked`). The `buffered[]` queue remains.
3. Ledger transitions wired: `eos.interim` → `add`; promote → `commit`; discard (mismatch/retracted/interrupt/llm-error) → `revoke`.
4. `onEvent` pushes an `iu_ledger`-tagged recoverable packet (debug/`llm.error`, `component: "iu_ledger"`) on the bus — the hook's first real use.
5. A new `speculative-on-ledger.test.ts` proves: promote == `commit`, discard == `revoke`, IU id carries a monotonic `epoch`, and the `onEvent` anomaly surfaces on a double-commit.
6. `pnpm --filter @kuralle-syrinx/aisdk typecheck && test` green; workspace typecheck no worse than baseline.

**Files:** `packages/aisdk/src/index.ts` (modify), `packages/aisdk/src/speculative-on-ledger.test.ts` (create). Possibly `packages/core/src/packets.ts` only if an `iu_ledger` debug packet needs a kind — prefer reusing the existing `llm.error` shape with `component: "iu_ledger"` (no new packet).

**Demo:** `sprints/sprint-1/artifacts/s1-01.txt` — `pnpm --filter @kuralle-syrinx/aisdk test` output showing the 4 unchanged speculative tests + the new ledger test green.

---

## 2. Universal DoD checklist (per story)

- [ ] The 4 existing speculative tests pass unchanged.
- [ ] Behavioral coverage: new ledger test has happy + failure paths.
- [ ] Proof JSON; manager proceed = **PROCEED** (manager re-runs aisdk typecheck+test).
- [ ] Demo artifact attached.
- [ ] No `--no-verify`, no `@ts-ignore`, no `as any`, no dual bookkeeping (old booleans gone).

---

## 3. Test plan

| Story | Layer | Test type | Fixtures |
|-------|-------|-----------|----------|
| S1-01 | unit | 4 existing speculative characterization (unchanged) | existing |
| S1-01 | unit | `speculative-on-ledger.test.ts`: commit/revoke mapping + epoch + onEvent | fake reasoner + spy |

NOT tested this sprint: leaf STT/TTS plugins (untouched); epoch ordering (no consumer — a monotonic counter suffices).

---

## 4. Demo plan

**Demo:** captured `pnpm --filter @kuralle-syrinx/aisdk test` at sprint end → `sprints/sprint-1/artifacts/s1-01.txt`.

---

## 5. Risks specific to this sprint

| Risk | Detection signal | Mitigation |
|------|------------------|------------|
| Re-expression breaks a speculative characterization test | Any of the 4 tests flips | RFC §11 abort: keep the private set, triage the divergence — do not force equivalence. |
| Collapsing the `buffered[]` queue into the ledger | Side-effect gating breaks (test 848 "nothing pushed" fails) | D-4: the buffer stays; only `promoted`/`failed` move to the ledger. |
| Latency regression on the hot path | aisdk timing / turn_latency | REQ-6: ledger is O(1), synchronous. |
| Scope creep into the leaf plugins / epoch reshape | Diff touches deepgram/tts/transports | Anti-scope in brief; `contextId` semantics unchanged. |

---

## 6. Open questions

- **OQ-S1-1 (resolved, D-4):** does removing `SpeculativeHold` mean removing the buffer? → No. Move `promoted`/`failed` to the ledger; keep `buffered[]`.
- **OQ-S1-2 (resolved):** where does `epoch` come from in aisdk (no transport counter here)? → a per-bridge monotonic counter assigned per turn contextId (`epochByContext`). No consumer reads it yet; monotonic is the only requirement.
