# Proceed Evidence — `S0-01` add Reasoner seam + ReasoningPart union (types only)

> **Manager artifact — Phase A only.** Confirms this story may proceed to the next.

---

## Story

- **Id:** `S0-01`
- **Commit:** `9581184` — `[S0-01] add Reasoner seam + ReasoningPart union (types only)`
- **IC slug:** `s0-01` (`.handoff/brief-s0-01.md`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] Diff read — scope matches brief §3 exactly: `reasoner.ts` (create), `reasoner.test.ts` (create), `index.ts` (append-only exports). No other files touched. `AISDKBridgePlugin` untouched.
- [x] `.handoff/proof-s0-01.json` exists.
- [x] `~/.agents/scripts/verify-handoff-proof.sh s0-01` → `PROOF_OK` (3 claims verified, 4 assertions satisfied).
- [x] `validation_contract.assertions_satisfied` equals `assertions_required` (`REQ-S0-01-types`, `test:reasoner_union_compile_guard`, `cmd:typecheck_voice`, `cmd:test_voice`).
- [x] Demo artifact: `reasoner.test.ts` (protocol/format snapshot) present and green.
- [x] No `--no-verify` / `@ts-ignore` / type-suppression in diff.

**Independent manager re-run (not trusting the proof alone):**
- `pnpm --filter @asyncdot/voice typecheck` → exit 0.
- `pnpm --filter @asyncdot/voice test` → 17 files, 186 tests pass (incl. `reasoner.test.ts`).

**Correctness check — union vs RFC §4.2:** `Reasoner`, `ReasonerTurn`, `ReasonerMessage`, `ReasoningPart` match RFC §4.2 byte-for-byte (field names, `readonly`, optionality, the `suspended` + `error` variants, and the `LATENCY INVARIANT` doc-comment on `Reasoner.stream`). No public-surface drift → no RFC amendment needed.

**Verdict:** `PROCEED`

---

## One-line summary

`Reasoner` seam + `ReasoningPart` union (incl. `suspended`/`error`, B1) added to `@asyncdot/voice` as types-only, exported, compile-guard test green · proof `s0-01` · commit `9581184`.

---

## Notes

- Compile-guard test constructs one literal of each of the 6 `ReasoningPart` variants + a trivial `Reasoner` — pins the union for when Sprint 3 wires `suspended`. Sound behavioral coverage for a types-only surface.
- Trap for S0-02: the adapter imports these types from `@asyncdot/voice` and must map the full `ai@6` `TextStreamPart` union onto them; the abnormal-terminal-`finish` → `error` coercion (PLAN §6) is the one non-mechanical decision.
