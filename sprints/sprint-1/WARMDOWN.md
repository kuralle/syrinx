# Sprint 1 — Warm-down

> **Author:** Opus 4.8 (1M) manager, 2026-07-09.
> **Sprint window:** 2026-07-09 (single session).
> **Outcome:** Goal achieved — speculative generation runs on the `IuLedger` (behavior-preserving), and the ledger has its first producer + first-class turn identity.

---

## 1. Goal recap

**Sprint goal:** speculative generation re-expressed as an `IuLedger` consumer (behavior-preserving; `SpeculativeHold` private state gone), and the ledger gains its first producer — a `user_turn` IU per turn.

**Did we hit it?** Yes, after one HOLD→fix cycle. The ledger is now the source of truth for speculative draft state; `SpeculativeHold` is just the side-effect buffer; the S0 `onEvent` hook fires real `iu_ledger` anomalies on the bus.

---

## 2. Stories shipped

| Story | Status | Commits | Demo | Notes |
|-------|--------|---------|------|-------|
| S1-01 | Done | `5768440` + `3d6770a` (fix) | [s1-01.txt](./artifacts/s1-01.txt) | HOLD round 1 (post-promotion regression), fixed round 2. |

---

## 3. What's working

- `interim → ledger.add(user_turn hypothesized)`; promote → `commit`; discard/retract/interrupt/llm-error → `revoke`. Draft state read from the ledger (`promoted`/`failed` booleans removed).
- IU id `{contextId, iuId: contextId, epoch}` with a monotonic per-turn `epoch` (`epochByContext`). No consumer reads ordering yet — monotonic is the only requirement.
- `onEvent` → recoverable `iu_ledger`-tagged `llm.error` on `Route.Background` (first real use of the S0 hook).
- Verified: 37 aisdk tests green (4 existing speculative unchanged + 4 ledger + regression guard); workspace typecheck no regression.

---

## 4. What's not working / known issues

| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| — | none | — | — | — |

The one real risk (post-promotion streaming) was caught and is now locked by `speculative-post-promotion.test.ts`.

---

## 5. Decisions made

- **D-4:** "Remove `SpeculativeHold` in favor of the ledger" = move commit *state* (`promoted`/`failed`) to the ledger, keep the side-effect *buffer*. Collapsing the buffer would break the gating. Source: `runs/iu-substrate-implementation-notes.md` D-4; `sprints/sprint-1/PLAN.md` §0. RFC amendment: none.
- **Regression discipline:** the manager pass built a repro (`speculative-post-promotion.test.ts`) that proved a mid-stream-promotion behavior regression the 4 characterization tests missed — kept as a permanent guard. This is the reusable lesson: the speculative suite needs a streaming-past-promotion case, now it has one.

---

## 6. Wiki / RFC amendments this sprint

The C5 rescope amendment (`docs/rfc-incremental-unit-substrate-amendment-C5.md`, committed `23794b1` in the prior step) governs why Sprint 1 = C2. No further amendments this sprint. `packets.ts` `component` union gained `"iu_ledger"` (additive; matches the packet taxonomy).

---

## 7. Metrics

- **Test count:** aisdk 37 (added: 4 `speculative-on-ledger` + 1 post-promotion regression guard).
- **Diff:** `index.ts` net ~+53 lines (round 1) then −2 (fix); `packets.ts` +2 union members; 1 new test file (211 lines) + 1 regression guard.
- **Rounds:** 1 HOLD, 1 fix. Worker: grok.

---

## 8. Backlog updates

**Added (prior step, still standing):** B-05 (standalone contextId→epoch reshape, consumer-gated), B-06 (structural turn-boundary re-arm).

---

## 9. Retrospective

### Keep
Front-loading the subtle design call (D-4) into the brief kept the IC on the faithful path; and the manager verification pass (re-run + read diff + build a repro for the untested path) is exactly what caught the regression green tests missed. Do both every sprint.

### Change
The initial brief should have *named* the mid-stream-promotion case as an explicit acceptance criterion (I relied on "behavior-preserving" + the existing suite, which didn't cover it). For reshapes of streaming code, enumerate the timing-sensitive cases in the brief, not just "keep tests green."

### Try next
For Sprint 2 (heard-prefix, C3 — barge-in mid-stream), pre-write the timing-sensitive acceptance cases (interrupt during streaming, word-boundary vs ms-fallback) into the brief before delegating.

---

## 10. Pointers for the next sprint

- Files to read first: `docs/rfc-incremental-unit-substrate.md` §8 C3, §4.3, §6, REQ-4; `packages/core/src/voice-agent-session.ts` (the `interrupt.tts` / barge-in path, `handleTurnComplete`, `commitInterruptedHistory`); `packages/core/src/tts-playout-clock.ts`; `packages/aisdk/src/index.ts` (`commitInterruptedHistory`, `spokenByContext`/`wordTimestampsByContext`/`playedOutMsByContext` — the heard-prefix precision ladder).
- Trap: heard-prefix has two precision paths (word timestamps vs `spokenByContext` ms fallback) — C3 must handle both, and the RFC §11 symptom-patch stop applies (must work for all transports through the ledger, not one special-case).
- The ledger now has assistant-side too: C3 commits the *assistant* IU's heard prefix. The bridge already tracks `spokenByContext` — C3 wires `ledger.commit(assistantIu, prefix=heard)`.
- Trap (learned this sprint): enumerate timing-sensitive cases (interrupt mid-stream) in the brief up front.

---

## 11. Closeout

- [x] Story committed atomically on `plan/iu-substrate` (`5768440` + fix `3d6770a`).
- [x] Proceed evidence (HOLD→PROCEED) + sprint review written.
- [x] Regression guard authored + committed at close.
- [x] `HANDOFF.md` written; `STATE.md` advanced to Sprint 2.
- [x] Demo artifact archived.

Sprint 1 is closed.
