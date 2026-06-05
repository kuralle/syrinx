# Review (r1, sandwich) — Sprint 0 (Seam foundation): `S0-01` + `S0-02`

> **Reviewer (main session):** claude-opus-4-8[1m] · manager · 2026-06-05.
> **Diff under review:** local branch `v2`, commits `9581184` (S0-01) + `3d314b4` (S0-02) — `git diff 0c77044..HEAD` (6 files, +641, −0).
> **Story briefs:** [`brief-s0-01.md`](../../.handoff/brief-s0-01.md), [`brief-s0-02.md`](../../.handoff/brief-s0-02.md)
> **Proceed evidence:** [`proceed-S0-01.md`](./proceed-S0-01.md), [`proceed-S0-02.md`](./proceed-S0-02.md)

The sandwich method: strengths, substantive critique, constructive close.

---

## 1. Strengths

- **No-buffering is enforced by construction *and* proven by a real test**, not asserted. `mapTextStreamParts` is a flat `for await (const part of source) { … yield … }` (`from-ai-sdk.ts:119`) — each part is remapped and yielded in the same loop turn, with the assistant text accumulated as a side string (`:122`) without ever delaying a `yield`. The test (`from-ai-sdk.test.ts:222`) drives the iterator's first `.next()` and asserts the `text-delta` resolves *while the source generator blocks on an unresolved gate*. This is exactly the RFC §7a / §4.2 latency invariant, verified — the single most important property of this seam.

- **The error/terminal discipline mirrors `processTurn` faithfully (B1).** `error`/`tool-error`/`abort` and `finish-step(error|content-filter)` each `yield toErrorPart(cause); return;` (`from-ai-sdk.ts:143,149,154,159`), and the no-`finish` fallback emits `"AI SDK stream ended without a provider finish reason"` (`:197`) — byte-identical to today's `validateFinalFinishReason` (`index.ts:398`). `recoverable` is derived through the project's own `isRecoverable(categorizeLlmError(cause))` (`:207`), so the part carries the same recoverability the current `catch` computes — the Sprint-1 re-home can consume it directly.

- **Abnormal terminal `finish` → `error` was handled, not dropped (PLAN §6).** `finish` with `error|content-filter|other|unknown` routes to a terminal `error` (`from-ai-sdk.ts:183`) while `stop|tool-calls|length` → `finish` (`:167`). The `ReasoningPart.finish.reason` union (`reasoner.ts:53`) literally cannot represent the abnormal reasons; the IC took the documented resolution rather than silently coercing them to `stop`, which would have masked a provider failure.

- **Seam transcription is exact (S0-01).** `reasoner.ts` reproduces RFC §4.2 to the character — the `suspended`/`error` variants designed-in now (`:48,:52`) and the latency-invariant doc-comment on `Reasoner.stream` (`:16`). The compile-guard test constructs one literal of each of the 6 variants, pinning the union for the Sprint-3 `suspended` wiring.

(Baseline facts — `pnpm -r typecheck`/`pnpm -r test` green, the 9 existing bridge tests still pass — are *not* counted as strengths per the template; they are the floor, and they hold.)

---

## 2. Critique

### 2.1 Blockers

None.

### 2.2 Majors

None.

### 2.3 Minors

#### m1. `mapMessages` emits a placeholder `toolName: ""` for tool-role history
- **Where:** `from-ai-sdk.ts:103`
- **What:** `ReasonerMessage` (`reasoner.ts:42`) carries no `toolName`, so a `role:"tool"` history message is converted to an AI SDK `tool-result` content block with `toolName: ""`.
- **Severity:** minor — **not exercised this sprint** (the bridge stores only user/assistant history; `index.ts:319`). It compiles and is harmless until tool-role history is ever persisted.
- **Proposed fix:** defer. If Sprint 1+ ever stores tool-role messages, either add `toolName` to `ReasonerMessage` (RFC §4.2 amendment) or carry it in `toolCallId`. Tracked in `proceed-S0-02.md` notes; no action needed now.

### 2.4 Nits

- `fromStreamText` spreads `StreamTextConfig` without defaulting `maxRetries:0`/`timeout` (`from-ai-sdk.ts:79`); today's bridge sets `maxRetries:0` (`index.ts:279`). Not wired to a live call this sprint — the S1-02 call site must pass them. Noted in proceed evidence.
- IC dropped `s0-02-implementation-notes.md` + `s0-02-scratchpad.md` at repo root; manager relocated them to `.handoff/` (untracked, not in the commit).

---

## 3. Cross-cutting concerns

- **Type-safety holes:** none in source. `from-ai-sdk.ts` has zero `any`/`@ts-ignore`. The `as TextStreamPart<ToolSet>` casts are confined to the **test** fixtures (`from-ai-sdk.test.ts`), constructing scripted parts — the same pattern the existing `index.test.ts:441` uses; acceptable for test scaffolding.
- **Failure-path coverage:** every terminal branch is exercised — `error` (`:135`), `tool-error` (`:159`), `finish-step(error)` (`:167`), `finish(length)` (`:184`), no-`finish` fallback (`:245`), plus a dropped-part case and the no-buffering case. This is genuine behavioral coverage, not shape assertions.
- **Latency:** the seam adds one microtask + a synchronous object remap per part, exactly as RFC §7a predicts; no I/O hop, no batching. No conversational-path runtime is wired this sprint, so there is nothing to measure yet — the LLM-TTFT gate begins in Sprint 1 (baseline captured at S1-00).
- **Dependency surface:** zero new deps. Both files import only `ai`, `@ai-sdk/openai` (unused here — actually only `ai` + `@asyncdot/voice`), and the existing seam. Edge bundle untouched (no edge-reachable code this sprint; gate begins S1-03).
- **Public-surface drift:** none. `ReasoningPart` matches RFC §4.2 verbatim → no RFC amendment required.

---

## 4. Constructive close

There is nothing to fix this sprint. The diff is additive (+641/−0), the seam matches the RFC to the character, the adapter mirrors `processTurn`'s exact error/terminal semantics, and the latency invariant is enforced by construction and proven by a gate-based test. The one minor (`toolName: ""`) and the two nits are all forward-looking notes for Sprint 1, already captured in the proceed evidence — none block. **No fix-pass commit is warranted.** The carry-forward for the Sprint-1 re-home: distinguish a signal-abort (barge-in → silent `return`) from an `abort` *stream-part* (→ `error`), and have the S1-02 `fromStreamText` call site set `maxRetries:0`.

---

## 5. Verdict

- [x] **Approve with minor fixes.** No blockers, no majors. The single minor and two nits are deferred forward-looking notes (documented in proceed evidence), not this-sprint fixes — so no `[S0-fix]` commit is required.

Path forward: proceed directly to warm-down (Step 3) and advance to Sprint 1.
