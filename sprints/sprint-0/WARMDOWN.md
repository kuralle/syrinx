# Sprint 0 — Warm-down

> **Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05.
> **Sprint window:** 2026-06-05 → 2026-06-12 (closed early, same day — scope was two type/adapter stories).
> **Outcome:** Goal achieved. The `Reasoner` seam + `ReasoningPart` union exist in `@asyncdot/voice` and the AI SDK adapters map `TextStreamPart` → `ReasoningPart` with no buffering, fully unit-tested.

---

## 1. Goal recap

**Sprint goal (from WBS):** The `Reasoner` seam + `ReasoningPart` union exist in `@asyncdot/voice`, and the AI SDK adapter maps `TextStreamPart` → `ReasoningPart` with no buffering, fully unit-tested.

**Did we hit it?** **Yes.** Both stories shipped, each with a PROCEED, and the sprint passed Phase B manager review with no blockers/majors and no fix-pass required. The seam is transcribed verbatim from RFC §4.2; the adapter mirrors today's `processTurn` error/terminal semantics exactly (B1) and the no-buffering latency invariant is proven by a gate-based test, not just asserted. Nothing live or edge-reachable was touched, so the latency/edge gates correctly do not apply this sprint — they begin in Sprint 1.

---

## 2. Stories shipped

| Story | Status | Commit | Demo | Notes |
|-------|--------|--------|------|-------|
| S0-01 | Done | `9581184` | `packages/voice/src/reasoner.test.ts` (compile-guard, green) | Seam + union (incl. `suspended`/`error`, B1) as types-only, exported. |
| S0-02 | Done | `3d314b4` | `packages/voice-bridge-aisdk/src/from-ai-sdk.test.ts` (9 tests, green) | `fromAiSdkAgent`/`fromStreamText`/`fromStreamFactory` via one no-buffering mapping generator. |

No stories slipped.

---

## 3. What's working

- **The seam compiles and is exported** (`@asyncdot/voice` → `Reasoner`, `ReasonerTurn`, `ReasonerMessage`, `ReasoningPart`), pinned by `reasoner.test.ts` which constructs all 6 `ReasoningPart` variants.
- **A scripted `fullStream` of `TextStreamPart`s flows through `fromAiSdkAgent`/`fromStreamFactory` and yields the exact normalized `ReasoningPart` sequence** incl. `finish` and every error path — the WBS Sprint-0 demo, runnable and green (`from-ai-sdk.test.ts`).
- **No buffering, proven:** `from-ai-sdk.test.ts:222` asserts the first `text-delta` resolves while the source generator blocks on an unresolved gate.
- **The 9 existing bridge tests remain green** — `AISDKBridgePlugin` was not touched; the adapter is purely additive.

---

## 4. What's not working / known issues

| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| KI-0-01 | `mapMessages` emits `toolName: ""` for `role:"tool"` history (`from-ai-sdk.ts:103`) — `ReasonerMessage` carries no `toolName`. Not exercised (bridge history is user/assistant only). | minor | Sprint 1+ | Revisit only if tool-role history is persisted; may need an RFC §4.2 field. |
| KI-0-02 | `fromStreamText` does not force `maxRetries:0`/`timeout` (`from-ai-sdk.ts:79`); today's bridge sets `maxRetries:0` (`index.ts:279`). | minor | Sprint 1 (S1-02) | The live `fromStreamText` call site must pass them. |

---

## 5. Decisions made

- **Decision:** Abnormal **terminal** `finish` reasons (`error`/`content-filter`/`other`/`unknown`) map to a terminal `error` `ReasoningPart`, not a `finish` part. **Rationale:** `ReasoningPart.finish.reason` is only `stop|tool|length` and cannot represent them; today's `validateFinalFinishReason` (`index.ts:397`) throws on non-`stop` to drive retry. Coercing them to `stop` would mask a provider failure. `length` stays a `finish:length` part (the Sprint-1 bridge `finish` case rejects it → `llm.error`, matching the existing token-limit test). **Source:** [`PLAN.md`](./PLAN.md) §6. **RFC amendment:** none — `ReasoningPart` is unchanged; this is a faithful normalization of current behavior, to be validated against the 9 tests in Sprint 1.

---

## 6. Wiki / RFC amendments this sprint

No amendments this sprint. `ReasoningPart` matches RFC §4.2 verbatim; no public-surface drift.

---

## 7. Metrics

- **Test count:** +10 this sprint (S0-01: 1 compile-guard; S0-02: 9 adapter tests). Workspace-wide `pnpm -r test` green.
- **Lines of code:** +641 / −0 across 6 files (2 source + 2 test + 2 export edits).
- **Latency:** not measured — no conversational-path runtime touched this sprint. Baseline capture is Sprint 1, S1-00.
- **Bundle/deps:** zero new dependencies; edge bundle untouched.

---

## 8. Backlog updates

**Added:** none.
**Promoted from backlog:** none.
**Removed:** none.

(Seeded backlog B-01…B-04 unchanged — see WBS §4.)

---

## 9. Retrospective

### Keep
The brief-driven Phase A loop worked cleanly: transcribing RFC §4.2 *verbatim* into the brief (rather than paraphrasing) gave a zero-drift seam, and pre-staging the S0-02 brief while S0-01 ran kept momentum without firing the dependent story early. The IC produced behavior-asserting tests (gate-based no-buffering proof), not shape assertions.

### Change
The IC dropped two scratch `.md` files at repo root; the brief should explicitly tell the IC to keep scratch notes inside `.handoff/`. Minor, manager cleaned it up, but worth a line in future briefs.

### Try next
For Sprint 1, capture the latency baseline (S1-00) **before** writing any other story brief, so every subsequent brief can cite the concrete P50/P95 band rather than a placeholder.

---

## 10. Pointers for the next sprint

- **Files to read first (Sprint 1):** `packages/voice-bridge-aisdk/src/index.ts` (the `AISDKBridgePlugin` to re-home), `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` (the adapter it will be driven by — esp. `fromStreamFactory`), `packages/voice/src/reasoner.ts`, and `docs/rfc-reasoner-bridge.md` §4.4/§4.5/§7a + §8 commits 1.0/1.3–1.5.
- **Traps:** (1) distinguish a **signal-abort** (barge-in → silent `return`) from an `abort` *stream-part* (→ `error`); the adapter maps the part to `error`, but the bridge must still treat `signal.aborted` as a silent return. (2) S1-02's `fromStreamText` call site must set `maxRetries:0`. (3) The abnormal-terminal-`finish`→`error` decision (PLAN §6) must be validated against the 9 tests during the re-home.
- **Latency:** Sprint 1 starts with S1-00 — run `smoke:websocket-interactive` ×3 on `v2` HEAD, record LLM-TTFT P50/P95 + band in `docs/latency-budget.md`. This is the denominator for every later gate.
- **Open RFC amendments in flight:** none.

---

## 11. Closeout

- [x] All shipped stories committed on `v2` (`9581184`, `3d314b4`); merge to trunk is via PR after the program ships (not mid-sprint).
- [x] Phase B review complete — Approve, no fix-pass required ([`review-sprint.md`](./review-sprint.md)).
- [x] Backlog deltas: none this sprint (WBS §4 unchanged).
- [x] `sprints/sprint-0/HANDOFF.md` written.
- [x] `sprints/STATE.md` updated with the Sprint-1 pointer + load-bearing reading list.
- [x] Demo artifacts are the two green test files (referenced above); no binary artifact needed for a types/adapter sprint.

Sprint 0 is closed.
