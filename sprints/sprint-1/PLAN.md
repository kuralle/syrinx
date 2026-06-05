# Sprint 1 — Plan

**Sprint name:** Re-home the bridge (zero behavior change + live)
**Sprint goal (one sentence):** The production bridge drives a `Reasoner` internally with zero behavior change (the 9 `index.test.ts` tests' assertions unchanged; construction adapts via `fromStreamFactory` — B2), is constructed with an explicit `fromAiSdkAgent(...)` (no auto-wrap — B3), and runs a live turn on the deployed worker with LLM-TTFT within the S1-00 baseline band (M3).
**Sprint window:** 2026-06-05 → 2026-06-12
**Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05

**Read first:** [`.understanding/bridge-rehome.md`](../../.understanding/bridge-rehome.md) — the re-home map (6-case switch, config split, call-site migration, invariants, OQ-1/OQ-2). Every story brief links it.

---

## 1. Stories

Order is strict: **S1-00 → S1-01 → S1-02 → S1-03** (each depends on the prior). S1-00 is manager-run instrumentation (the baseline is the deliverable; the manager runs + verifies the numbers empirically rather than delegating measurement). S1-01/S1-02 are IC impl. S1-03 is the live/edge proof.

### `S1-00` — Capture the pre-refactor LLM-TTFT baseline (M3)

**Description:** Before any refactor, run `pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-interactive` **×3** on `v2` HEAD and record LLM-TTFT **P50/P95** + a variance band in `docs/latency-budget.md`. This is the denominator every later latency gate in the program compares against. The existing `docs/latency-budget.md` baseline is **stale** (gemini-3.1-flash-lite); the bridge now runs OpenAI `gpt-4.1-mini` (commit `35601f6`), so this captures the current-provider baseline.

**Acceptance criteria:**
1. `smoke:websocket-interactive` run 3× on `v2` HEAD (current commit, pre-S1-01). Each run's per-stage LLM-TTFT P50/P95 captured.
2. `docs/latency-budget.md` gains a dated "Sprint-1 S1-00 baseline (gpt-4.1-mini)" section recording: the 3 runs' LLM-TTFT P50 + P95, the **mean** P50/P95, and a **variance band** = `±max(5%, run-to-run spread)` (per RFC §7a/M3 — "≤ ~5% or a few ms, whichever is larger").
3. The band is stated as an explicit numeric interval (e.g. "P50 gate: ≤ X ms") so S1-01/S1-03 can assert against it mechanically.
4. The raw run artifacts (the harness writes JSON under `test/performance/runs/`) are referenced.

**Files modified:** `docs/latency-budget.md`. **Manager-run** (no IC). Commit `[S1-00] capture pre-refactor LLM-TTFT baseline (gpt-4.1-mini)`.

**Demo artifact:** the 3 run JSONs + the committed baseline section.

### `S1-01` — Drive `AISDKBridgePlugin` from a `Reasoner` internally

**Description:** Replace the `streamResponse`/`fullStream` loop in `processTurn` with `this.reasoner.stream(turn)` + a **6-case `ReasoningPart` switch** (per `.understanding/bridge-rehome.md` §"The 6-case switch"), incl. `error` → the existing retry/`llm.error` path (B1). Keep history, spoken-prefix barge-in, retry, idle-timeout, turn-superseding **identical**. No buffering. At this story the constructor still accepts the `AISDKStreamFactory` (rename + Reasoner-only constructor is S1-02) — **OR** introduce the `Reasoner` field now and have the existing constructor wrap the factory via `fromStreamFactory` internally (preferred, smaller S1-02). The IC chooses the smaller diff; either way the 9 tests' **assertions are unchanged**.

**Acceptance criteria:**
1. `processTurn` drives `this.reasoner.stream({ userText, messages, signal })` where `messages` is the bridge's history (`ReasonerMessage[]`) and `signal` is `activeGeneration.controller.signal`. The 6-case switch matches the `.understanding` table.
2. **Preservation invariants** (`.understanding` §"Critical preservation rules"): signal-abort is a silent `return` (never an `error`-part `llm.error`); `finish(length)` → `llm.error` (token-limit test, `index.test.ts:70`); no-`finish` → `llm.error` (`index.test.ts:98`); `emittedDelta` gates retry; `rememberTurn` only on committed `llm.done`; `llm.finish_reason` metric still emitted (OQ-1).
3. **The 9 `index.test.ts` tests: assertions/behavior byte-for-byte unchanged.** Construction adapts to `new ReasoningBridge(fromStreamFactory(fn))` here or in S1-02 (IC's choice of where the rename lands; if S1-01 keeps the `AISDKBridgePlugin` name, the construction line is unchanged this story).
4. `withStreamIdleTimeout` wraps `reasoner.stream(turn)` correctly (OQ-2 — type as `AsyncIterable`).
5. `pnpm --filter @asyncdot/voice-bridge-aisdk test` green (18 tests). **LLM-TTFT P50/P95 within the S1-00 band** — manager re-runs `smoke:websocket-interactive` after this story (gate, not the deployed turn).
6. No buffering introduced; no behavior change observable in the 9 tests or the smoke.

**Files modified:** `packages/voice-bridge-aisdk/src/index.ts` (+ possibly `index.test.ts` construction lines if the rename lands here). Commit `[S1-01] drive the bridge from a Reasoner internally`.

**Demo artifact:** the 18 green tests + the post-S1-01 smoke LLM-TTFT vs the S1-00 band.

### `S1-02` — Rename to `ReasoningBridge`; accept a `Reasoner` only (no auto-wrap, B3)

**Description:** Rename `AISDKBridgePlugin` → `ReasoningBridge`; the constructor accepts a **`Reasoner` only**. Callers wrap explicitly via `fromAiSdkAgent`/`fromStreamText`/`fromStreamFactory` — **no `.stream()`-probe auto-wrap** (B3). Migrate the **config split** (`.understanding` §"Config split"): provider config (`api_key`/`model`/`system_prompt`/`tools`/`tool_choice`/`temperature`/`max_output_tokens`/`max_steps`) moves to the adapter at the call site; bridge config (`timeout_ms`/`max_history_turns`/retry) stays in `initialize`. Update the 4 call sites: `voice-server-workers/src/live-session.ts:80` + the 3 examples. Zero-debt: **remove** `AISDKBridgePlugin` (no compat alias unless a caller needs it — none do).

**Acceptance criteria:**
1. `ReasoningBridge` constructor signature is `(reasoner: Reasoner)`. No duck-typing / no `.stream()` probe.
2. The 4 call sites construct `new ReasoningBridge(fromStreamText({ model: createOpenAI({apiKey})(model), system, temperature, maxOutputTokens, maxRetries: 0, timeout, stopWhen: stepCountIs(maxSteps), tools, toolChoice }))` — **`maxRetries: 0` mandatory** (KI-0-02). Keys/model are in scope at each site (`live-session.ts:63`; examples read `process.env`).
3. The 9 tests construct `new ReasoningBridge(fromStreamFactory(fn))`; **assertions unchanged**.
4. `AISDKBridgePlugin` is removed; no call site uses auto-wrap; the `from-ai-sdk.ts` re-exports unchanged.
5. `pnpm -r typecheck && pnpm -r test` green. **No behavior change** — smoke LLM-TTFT within the S1-00 band.

**Files modified:** `packages/voice-bridge-aisdk/src/index.ts`, `index.test.ts`, `voice-server-workers/src/live-session.ts`, `examples/02-hello-voice-headless/src/run-one-turn.ts`, `.../src/university-support-agent.ts`, `.../scripts/run-university-support-baseline.ts`. Commit `[S1-02] rename to ReasoningBridge; Reasoner-only constructor + explicit wraps`.

**Demo artifact:** `pnpm -r typecheck && pnpm -r test` green + post-S1-02 smoke.

### `S1-03` — Live worker proof (functional) + latency gate

**Description:** Confirm `verify-edge-bundle.sh` clean; run the opt-in live worker turn (`SYRINX_LIVE_WORKER_TEST=1 pnpm --filter @asyncdot/voice-server-workers test`); deploy + drive one turn on the deployed worker (functional proof — transcribes + returns TTS). The **latency gate is the local harness** (`smoke:websocket-interactive` within the S1-00 band), **not** the deployed turn.

**Acceptance criteria:**
1. `bash scripts/verify-edge-bundle.sh` clean (the re-home pulled no Node-only deps into the edge build).
2. `SYRINX_LIVE_WORKER_TEST=1 pnpm --filter @asyncdot/voice-server-workers test` passes.
3. Deployed `/ws` turn transcribes + returns TTS (functional live proof on the deployed worker).
4. `smoke:websocket-interactive` LLM-TTFT P50/P95 within the S1-00 band (the gate).

**Files modified:** likely none beyond config; deploy is an action. Commit `[S1-03] live worker turn through the generalized bridge (AI SDK)` (+ any wiring fix). **Deploy is an outward-facing action — manager surfaces it before running.**

**Demo artifact:** deployed-worker transcript + TTS bytes + the before/after LLM-TTFT comparison.

---

## 2. Universal DoD checklist (per story)

- [ ] `pnpm -r typecheck && pnpm -r test` green (per-package during a story; workspace-wide at S1-02/closeout).
- [ ] Behavioral coverage preserved — the 9 bridge tests' assertions byte-for-byte unchanged.
- [ ] **Latency gate (S1-01, S1-02, S1-03):** `smoke:websocket-interactive` LLM-TTFT P50/P95 within the S1-00 band.
- [ ] **Edge gate (S1-03):** `verify-edge-bundle.sh` clean.
- [ ] Proof JSON + manager proceed evidence = PROCEED (IC stories S1-01/S1-02).
- [ ] No `--no-verify`, no `@ts-ignore`, no silent-catch.
- [ ] Atomic commit `[S1-{nn}]` on `v2`.

---

## 3. Test plan

| Story | Layer | Test type | Fixtures |
|-------|-------|-----------|----------|
| S1-00 | instrumentation | live smoke ×3, LLM-TTFT P50/P95 | university-support fixtures (live providers) |
| S1-01 | unit + smoke | 9 unchanged bridge tests + LLM-TTFT gate | scripted factory streams + live smoke |
| S1-02 | unit + workspace | 9 tests (construction adapts) + `pnpm -r test` + smoke | scripted streams + live smoke |
| S1-03 | edge + live | edge-bundle clean + opt-in worker turn + deployed turn + LLM-TTFT gate | deployed worker |

What we will NOT test: Mastra (Sprint 2), suspend/resume (Sprint 3). Realtime is out of scope (B-01).

---

## 4. Demo plan

**Demo:** a deployed-worker live turn (transcript + TTS bytes) plus an LLM-TTFT before/after comparison (S1-00 baseline vs post-re-home smoke) showing no regression — the WBS Sprint-1 demo.

---

## 5. Risks specific to this sprint

| Risk | Detection | Mitigation |
|------|-----------|------------|
| Behavior drift hiding in the refactor | the 9 unchanged tests + LLM-TTFT smoke | behavior-preserving, independently-revertible commits; the `.understanding` preservation rules are the checklist |
| signal-abort vs `abort`-part confusion | `index.test.ts` mid-generation barge-in test (`:338`) | `.understanding` rule 1 — `signal.aborted` short-circuits before the `error` case |
| `finish(length)` no longer → `llm.error` | `index.test.ts:70` | `.understanding` rule 2 — bridge `finish` case rejects `length` |
| LLM-TTFT regression beyond band (HARD FLAG) | post-story smoke vs S1-00 | the seam is a passthrough (Sprint 0 proved no buffering); if it regresses beyond noise and can't be designed away → stop + surface |
| config-split migration breaks a call site | `pnpm -r typecheck && pnpm -r test` | keys/model in scope at every site; `maxRetries:0` mandatory |
| edge bundle pulls a Node-only dep | `verify-edge-bundle.sh` (S1-03) | re-home adds no new imports beyond `ai`/`@asyncdot/voice` already in the edge build |

---

## 6. Open questions

- **OQ-1** (`.understanding`): `llm.finish_reason` metric after re-home — resolved: the bridge `finish` case re-emits it with the mapped `reason`; the `rawFinishReason` detail is dropped but no test asserts it. Confirm green at S1-01.
- **OQ-2** (`.understanding`): `withStreamIdleTimeout` typed for `AsyncIterable<ReasoningPart>`. <15 min at S1-01.
- **S1-01 vs S1-02 boundary:** where the `ReasoningBridge` rename lands (S1-01 internal-wrap vs S1-02 full rename). IC picks the smaller, behavior-preserving diff; the 9 tests' assertions are unchanged regardless.
