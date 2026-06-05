# Sprint 0 — Plan

**Sprint name:** Seam foundation
**Sprint goal (one sentence):** The `Reasoner` seam + `ReasoningPart` union exist in `@asyncdot/voice`, and the AI SDK adapter maps `TextStreamPart` → `ReasoningPart` with no buffering, fully unit-tested.
**Sprint window:** 2026-06-05 → 2026-06-12
**Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05

---

## 1. Stories

Two stories. **S0-02 depends on S0-01** (imports the types). Run them in order; collect proceed evidence on each before moving on. No conversational-path runtime is touched this sprint, so **no latency gate applies** (the latency baseline is captured in Sprint 1, S1-00, before the bridge is re-homed). No edge-reachable code is touched, so no edge-bundle gate this sprint either — both new files are type/adapter code with no Node-only deps; the edge bundle is exercised in S1-03.

### `S0-01` — Add the `Reasoner` seam + `ReasoningPart` union (types only)

**Description:** Create `packages/voice/src/reasoner.ts` containing the `Reasoner` interface, `ReasonerTurn`, `ReasonerMessage`, and the `ReasoningPart` union **exactly** as specified in RFC §4.2 (lines 61–109), including the `suspended` **and** `error` variants now (B1 — designed once; `error` is wired in Sprint 1, `suspended` in Sprint 3). Export all of them from `packages/voice/src/index.ts`. There are **no runtime consumers** this sprint — types only. The `LATENCY INVARIANT` doc-comment from RFC §4.2 must be present verbatim on `Reasoner.stream`.

**Acceptance criteria** (numbered, in priority order):
1. `packages/voice/src/reasoner.ts` exists and declares `Reasoner`, `ReasonerTurn`, `ReasonerMessage`, `ReasoningPart` with field names, optionality, and `readonly` modifiers **byte-for-byte matching RFC §4.2** (incl. the `suspended` and `error` variants).
2. The `LATENCY INVARIANT` doc-comment (RFC §4.2, the block on `stream`) is on `Reasoner.stream`.
3. All four are re-exported from `packages/voice/src/index.ts` (type-only exports, grouped with a `// Reasoner seam` comment).
4. `pnpm --filter @asyncdot/voice typecheck` is green. `pnpm --filter @asyncdot/voice test` is green (the new compile-guard test passes).
5. No runtime consumers added; no existing file other than `index.ts` is modified.

**Files expected to be created or modified:**
- `packages/voice/src/reasoner.ts` (create)
- `packages/voice/src/reasoner.test.ts` (create — compile-guard)
- `packages/voice/src/index.ts` (modify — add exports only)

**Test fixtures the worker will add:**
- `reasoner.test.ts`: constructs one literal of **each** `ReasoningPart` variant and a trivial `Reasoner` implementation, asserting the shapes are assignable (a compile-guard that pins the union; runs under vitest with a trivial runtime assert). This is the "behavioral coverage" surface for a types-only story — it regression-guards the union when Sprint 3 wires `suspended`.

**Demo artifact:** `reasoner.test.ts` itself (green run) — a protocol/format snapshot per STORY-BRIEF §7.

### `S0-02` — `fromAiSdkAgent` + `fromStreamText` + `fromStreamFactory` adapters → `Reasoner`

**Description:** Create `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` exporting three adapter factories that each return a `Reasoner`. All three normalize an `ai@6` `TextStreamPart<ToolSet>` stream into `ReasoningPart`s via **one shared mapping generator** (DRY). The mapping covers the **full** `TextStreamPart` union per RFC §4.3 — including the **`error`/`tool-error`/`abort`/`finish-step(error|content-filter)` → `error`** paths (B1, not dropped: today's bridge throws on these to drive retry) — and yields each part **immediately** (no buffering, no completion-await; latency invariant, RFC §7a). `fromStreamFactory` preserves the existing `AISDKStreamFactory` test seam (B2) so Sprint 1 can re-home the 9 tests with a one-line construction change.

**Acceptance criteria** (numbered, in priority order):
1. `from-ai-sdk.ts` exports `fromAiSdkAgent`, `fromStreamText`, `fromStreamFactory`, each `→ Reasoner`. Re-exported from `packages/voice-bridge-aisdk/src/index.ts`.
2. The shared mapping generator implements **exactly** this table (and yields each part the instant it arrives — no buffering, no awaiting the stream to completion):

   | `TextStreamPart.type` | `ReasoningPart` |
   |---|---|
   | `text-delta` | `{ type:"text-delta", text }` |
   | `tool-call` | `{ type:"tool-call", toolId: toolCallId, toolName, args: input as Record }` |
   | `tool-result` | `{ type:"tool-result", toolId: toolCallId, toolName, result: stringify(output) }` |
   | `error`, `tool-error`, `abort` | `{ type:"error", cause, recoverable }` — **terminal** (stop iterating after) |
   | `finish-step` with `finishReason` ∈ {`error`,`content-filter`} | `{ type:"error", cause, recoverable }` — **terminal** |
   | `finish` with `finishReason` ∈ {`stop`→`stop`, `tool-calls`→`tool`, `length`→`length`} | `{ type:"finish", reason, text }` |
   | `finish` with `finishReason` ∈ {`error`,`content-filter`,`other`,`unknown`} | `{ type:"error", cause, recoverable }` — **terminal** (see §6 decision) |
   | everything else (`text-start/end`, `start`, `start-step`, `reasoning-*`, `tool-input-*`, `source`, `file`, `raw`, `tool-output-denied`, tool-approval) | **dropped** |
3. `recoverable` on every `error` part = `isRecoverable(categorizeLlmError(cause))` (imported from `@asyncdot/voice`). `cause` is the underlying `Error` (or `new Error(String(...))` / a descriptive `Error` for `finish-step`/`finish` abnormal reasons).
4. The `finish` part's `text` is the **full accumulated assistant text** across this turn's `text-delta`s. Accumulating the string is allowed; **delaying delta emission is not** — each `text-delta` is still yielded immediately.
5. `fromAiSdkAgent(agent)` **`await`s** `agent.stream({ messages, abortSignal })` (it returns a `Promise<StreamTextResult>` — B3), then iterates `.fullStream`. `fromStreamText(config)` calls `streamText({ ...config, messages, abortSignal })` and iterates `.fullStream`. `fromStreamFactory(factory)` calls the `AISDKStreamFactory` with `{ userText, signal, messages }` and maps the yielded generator. All three convert `turn.messages` (`ReasonerMessage[]`) → `ModelMessage[]` and append the `userText` user message (mirroring today's `streamResponse`, `index.ts:264`).
6. `pnpm --filter @asyncdot/voice-bridge-aisdk test` green, with new tests in `from-ai-sdk.test.ts` covering: happy path (deltas + tool-call + tool-result + `finish:stop`); the `error`-part path; the `tool-error`-part path; the `finish-step(error)` → `error` path; the `finish(length)` → `finish:length` path; and a **dropped-part case** (a `reasoning`/`tool-input-start` part produces no `ReasoningPart`). At least one test per adapter factory (`fromStreamFactory` exercises the same scripted-generator shape the 9 Sprint-1 tests use).
7. No buffering: a test asserts the first `text-delta` is observed **before** the source stream completes (e.g. a never-finishing scripted stream still yields its first mapped part).
8. `pnpm --filter @asyncdot/voice-bridge-aisdk typecheck` green. **`packages/voice-bridge-aisdk/src/index.ts` (the existing `AISDKBridgePlugin`) is NOT modified** — it stays as-is; re-homing it onto the `Reasoner` is Sprint 1's job.

**Files expected to be created or modified:**
- `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` (create)
- `packages/voice-bridge-aisdk/src/from-ai-sdk.test.ts` (create)
- `packages/voice-bridge-aisdk/src/index.ts` (modify — **add re-export only**; do not touch `AISDKBridgePlugin`)

**Test fixtures the worker will add:**
- Scripted `TextStreamPart<ToolSet>` sequences (reuse the `textDelta`/`finish` helper shape from `index.test.ts:440`), plus `tool-call`/`tool-result`/`error`/`tool-error`/`finish-step` literals.
- A fake `AiSdkAgentLike` (`.stream()` returns `Promise<{ fullStream }>`) for `fromAiSdkAgent`.

**Demo artifact:** `from-ai-sdk.test.ts` (green run) — protocol/format snapshot per STORY-BRIEF §7.

---

## 2. Universal DoD checklist (per story)

- [ ] `pnpm --filter <pkg> typecheck` + `pnpm --filter <pkg> test` green (workspace-wide `pnpm -r typecheck && pnpm -r test` for the final closeout).
- [ ] Behavioral coverage: every public surface tested with at least one happy-path and one failure-path test (S0-01: compile-guard; S0-02: full mapping table incl. error paths + dropped-part).
- [ ] Proof JSON written to `.handoff/proof-s0-{nn}.json`; manager proceed evidence = **PROCEED**.
- [ ] Demo artifact present at `sprints/sprint-0/artifacts/` (or the test file referenced).
- [ ] No `--no-verify`, no `@ts-ignore`, no `try/except: pass`, no type-suppression.
- [ ] Atomic commit `[S0-{nn}] {title}` on `v2`.

---

## 3. Test plan

| Story | Layer | Test type | Fixtures |
|-------|-------|-----------|----------|
| S0-01 | unit | compile-guard: construct each `ReasoningPart` variant + a trivial `Reasoner` | inline literals |
| S0-02 | unit | mapping-table coverage (happy + error + tool-error + finish-step(error) + finish(length) + dropped-part + no-buffering) | scripted `TextStreamPart` sequences; fake `AiSdkAgentLike` |

What we will NOT test in this sprint, and why each is safe:
- The 9 existing `index.test.ts` bridge tests are **not** re-homed here — that is Sprint 1 (S1-01/S1-03). Sprint 0 leaves `index.ts` untouched, so those tests are unaffected.
- No live worker turn, no edge bundle, no latency measurement — Sprint 0 touches no conversational-path or edge-reachable runtime. Those gates start in Sprint 1.
- `fromStreamText` is exercised at the typecheck + one happy-path level only; its full config surface is validated when a real `streamText` call site adopts it (Sprint 1, S1-02 live path).

---

## 4. Demo plan

**Demo:** the two new test files run green: `pnpm --filter @asyncdot/voice test` (compile-guard pins the `ReasoningPart` union) and `pnpm --filter @asyncdot/voice-bridge-aisdk test` (a scripted `fullStream` of `TextStreamPart`s flows through `fromAiSdkAgent`/`fromStreamFactory` and asserts the exact normalized `ReasoningPart` sequence incl. `finish` and the error paths). This is the WBS Sprint-0 demo: "a unit test that feeds a scripted `fullStream` … and asserts the exact normalized `ReasoningPart` sequence, runnable and green."

---

## 5. Risks specific to this sprint

| Risk | Detection signal | Mitigation |
|------|------------------|------------|
| AI SDK v6 `TextStreamPart` field names drift | typecheck against installed `ai@6.0.191` types + adapter unit test | **Retired at plan time** — verified the full union (`text-delta`/`tool-call`/`tool-result`/`tool-error`/`error`/`abort`/`finish-step`/`finish` all present in `ai@6.0.191`). Mapping lives in one function; version pinned `^6.0.0`. |
| `ReasonerMessage` ↔ `ModelMessage` impedance | adapter test with scripted `messages`; Sprint-1 9-test re-home | Convert by `role`+`content` (the simple text-message shape the bridge already uses, `index.ts:264`); tool-role carries `toolCallId`. Full fidelity is proven when the 9 tests re-home in Sprint 1. |
| Hidden buffering creeping into the adapter (latency) | the no-buffering unit test (S0-02 AC7) | One shared `for await … yield map(part)` generator; a test asserts first-delta-before-stream-end. |

---

## 6. Open questions

**Resolved design decision (documented, not an RFC amendment — `ReasoningPart` union is unchanged):** RFC §4.3's table maps `finish-step(error|content-filter) → error` and `finish → finish`, but the `finish.reason` union is only `stop | tool | length` — it cannot represent an abnormal **terminal** `finish` reason (`error`, `content-filter`, `other`, `unknown`). Today's bridge throws on those (`validateFinalFinishReason`, `index.ts:397`) to drive the retry/`llm.error` path. To preserve that behavior **and** keep the mapping total, the adapter maps abnormal terminal `finish` reasons to a terminal **`error`** part (consistent with the `finish-step` rule), and maps only `stop|tool-calls|length` to a `finish` part. `length` stays a `finish:length` part (the Sprint-1 bridge `finish` case rejects it → `llm.error`, matching the existing "token limit" test). This is a faithful normalization of current behavior, not a public-surface change; it will be validated against the 9 bridge tests in Sprint 1. If Sprint 1 surfaces a behavior delta, revisit here.
