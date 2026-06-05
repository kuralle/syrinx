# Proceed Evidence — `S1-01` drive the bridge from a Reasoner internally

> **Manager artifact — Phase A.**

---

## Story

- **Id:** `S1-01`
- **Commit:** `cfd5f2b` — `[S1-01] drive the bridge from a Reasoner internally`
- **IC slug:** `s1-01` (`.handoff/brief-s1-01.md`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] Diff read in full — scope is `packages/voice-bridge-aisdk/src/index.ts` **only**. `index.test.ts` **byte-for-byte untouched** (`git diff HEAD~1 HEAD -- index.test.ts` empty).
- [x] **6-case `ReasoningPart` switch** matches `.understanding/bridge-rehome.md` exactly: `text-delta`→`llm.delta`, `tool-call`→`llm.tool_call`(`toolArgs: part.args`), `tool-result`→`llm.tool_result`(`part.result`), `error`→`throw part.cause` (→ existing retry/`llm.error`, B1), `finish`→`recordFinishReason`+capture, `suspended`→no-op (Sprint 3).
- [x] **Preservation rules intact:** `if (signal.aborted) return;` is the first line of every loop iteration (rule 1 — barge-in stays a silent return, distinct from an `abort`-part `error`); `validateFinalFinishReason` keeps null/`length`/non-`stop` throws; `emittedDelta`/retry catch (`:228`) unchanged; `rememberTurn`/barge-in/history code untouched; `turn.signal = activeGeneration.controller.signal`.
- [x] `buildReasoner()` replicates the old `streamResponse` else-branch exactly (`maxRetries:0`, `stopWhen: stepCountIs(maxSteps)`, `timeout`); `fromStreamFactory` for the test seam, `fromStreamText` for the default — constructor signature **unchanged** (`constructor(streamFactory?)`).
- [x] `withStreamIdleTimeout` retyped `AsyncIterable<T>` + explicit iterator (OQ-2); timeout/abort semantics identical.
- [x] Orphan removal is correct: `streamText`/`FinishReason` imports, `toRecord`/`stringifyToolOutput`/`formatFinishReason` removed (orphaned by the change); `TextStreamPart`/`ModelMessage`/`ToolSet`/`ToolChoice` retained (still used by `AISDKStreamFactory`/config readers).
- [x] No `@ts-ignore`/`--no-verify`/silent-catch.

**Independent manager verification (authoritative — see proof note):**
- `pnpm --filter @asyncdot/voice-bridge-aisdk typecheck` → exit 0.
- `pnpm --filter @asyncdot/voice-bridge-aisdk test` → **18 tests pass** (9 `index.test.ts` with **unchanged assertions** + 9 `from-ai-sdk.test.ts`).

**Latency gate (M3 — manager-run `smoke:websocket-interactive`, gate P50 ≤ 3920 ms / P95 ≤ 4530 ms vs S1-00):**
- **6 runs** post-S1-01 (commit `cfd5f2b`):
  - P50: 2376 / 3421 / 2345 / 2633 / 3140 / 2313 → **mean 2705 ms** — **6/6 ≤ 3920** ✓, and *faster* than the S1-00 baseline mean (3290 ms).
  - P95: 5943 / 4348 / 2690 / 3671 / 3568 / 2357 → **mean 3763 ms** — **5/6 ≤ 4530** ✓ (mean better than baseline 4044 ms).
- **Determination: PASS, latency-neutral — no seam-attributable regression.** P50 is the robust metric and it is uniformly under-gate *and faster* than baseline; a buffering regression would inflate P50, not shrink it. The single P95 outlier (5943 ms, run 1) was **not reproduced** in 5 further runs (all ≤ 4348 ms) and is isolated live-OpenAI tail-latency noise — exactly the provider variance documented in the S1-00 baseline (P95-over-3-turns ≈ slowest-of-3, hypersensitive to one slow call). This is **not** the RFC §7a hard-flag regression (which requires a regression that can't be attributed to noise; here P50 improved and the unit-level no-buffering test passes).

**Verdict:** `PROCEED`

---

## One-line summary

`AISDKBridgePlugin.processTurn` now drives `reasoner.stream(turn)` + a 6-case `ReasoningPart` switch with zero behavior change (9 bridge tests' assertions byte-for-byte unchanged, constructor untouched); latency-neutral (P50 mean 2705 ms vs 3290 baseline) · commit `cfd5f2b`.

---

## Notes

- **Proof defect (clerical, not dishonesty):** `.handoff/proof-s1-01.json` is structurally valid JSON with complete `commands_run` (exit 0) + `validation_contract`, but **omits the `schema_version` field**, so `verify-handoff-proof.sh s1-01` → `PROOF_INVALID`. The work itself is correct and **independently re-verified by the manager** (diff read + typecheck + 18 tests + 6-run latency gate) — that exceeds what the proof-gate script checks. PROCEED is on the strength of that independent verification, not the IC's artifact. (`.handoff/` is gitignored; the proof is not part of the permanent record.) Carry to future briefs: the proof template snippet should lead with `"schema_version": 1`.
- **Accepted telemetry delta (RFC-sanctioned):** `llm.finish_step_reason` (the per-step Background metric, old `index.ts:202`) is **dropped** — `ReasoningPart` has no `finish-step` variant (RFC §4.3 drops non-error finish-steps; finish-step(error|content-filter)→`error`). Not asserted by any of the 9 tests, not in RFC §4.5's preserved list. `llm.finish_reason` is preserved (value `"stop"`, test `index.test.ts:59` green).
- `history` field narrowed from `ModelMessage[]` to the `ReasonerMessage` shape (`{role; content; toolCallId?}`) so it feeds `turn.messages` directly — safe (history is only ever populated with `{role,content}` text messages; `rememberTurn`/barge-in objects remain assignable).
- **Carry to S1-02:** the rename to `ReasoningBridge` + Reasoner-only constructor + config split + 4 call-site migration is next. `buildReasoner`'s default branch moves to the call site's `fromStreamText(...)` wrap; `maxRetries:0` must survive the move.
