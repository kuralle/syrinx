# Review (r1, sandwich) — Sprint 1 (Re-home the bridge): `S1-00`…`S1-03`

> **Reviewer (main session):** claude-opus-4-8[1m] · manager · 2026-06-05.
> **Diff under review:** `v2`, commits `e2b549c` (S1-00) · `cfd5f2b` (S1-01) · `391d0f4`+`ad65e10` (S1-02) · S1-03 = deploy/verify (no code). `git diff 1db701f..HEAD` (9 files, +164/−194 — net code reduction).
> **Briefs:** `.handoff/brief-s1-01.md`, `.handoff/brief-s1-02.md`. **Understanding:** `.understanding/bridge-rehome.md`. **Proceed:** `proceed-S1-00`…`S1-03.md`.

---

## 1. Strengths

- **The re-home is a net *deletion* with zero behavior change.** `index.ts` lost ~194 lines net — the 10-branch `TextStreamPart` switch → a 6-case `ReasoningPart` switch, `streamResponse`/`formatFinishReason`/`toRecord`/`stringifyToolOutput` removed (`cfd5f2b`). The 9 `index.test.ts` assertions are byte-for-byte unchanged across both S1-01 (untouched) and S1-02 (construction line only). Proof that the seam was the right abstraction: less code, same behavior.
- **The barge-in safety property survived intact.** `if (signal.aborted) return;` remains the first line of the part loop (`index.ts`), keeping signal-abort distinct from the adapter's `abort`-stream-part→`error` mapping — the mid-generation barge-in test (`index.test.ts:338`) and the spoken-prefix history rewrite are unchanged. This was the single highest-risk invariant (RFC §4.5) and it held.
- **The config split is clean and honest** (`391d0f4`): provider config moved to explicit `fromStreamText(...)` wraps at all 4 call sites (no `.stream()`-probe auto-wrap, B3); `pluginConfig.bridge` now holds bridge-level keys only; `AISDKBridgePlugin` fully removed (zero-debt). `@ai-sdk/openai` added to the worker + example `package.json` exactly because the call sites now import `createOpenAI` directly — necessary, not creep.
- **Latency was instrumented, not asserted (M3 done right).** S1-00 captured a real OpenAI baseline and surfaced that the harness's *LLM* leg is live-API-noisy (P50 2773–3733 ms) — a correction to the RFC's "stable harness" assumption — then banded the gate against observed variance (`docs/latency-budget.md`). S1-01 was verified latency-neutral over 6 runs (P50 mean 2705 ms, *faster* than baseline — structurally impossible under a buffering regression).
- **The proof chain is real, not asserted.** Deployed-edge turn returned a true transcript + 141 KB TTS over `wss://`; workerd miniflare turn green; edge bundle clean.

## 2. Critique

### 2.1 Blockers — none. ### 2.2 Majors — none.

### 2.3 Minors

#### m1. The S1-02 brief omitted three config values (caught + fixed in-sprint)
- **Where:** `university-support-agent.ts` (fixed in `ad65e10`).
- **What:** the brief's per-site table missed `tools: studentRelationsTools`, `max_history_turns: 20`, and the profile-dependent `timeout_ms`; the IC transcribed the table faithfully and dropped them. The manager caught it in proceed evidence (the smoke path losing tool-calling) and fixed it directly. **Root cause: a manager brief built from a keyword grep, not the verbatim config block.**
- **Severity:** minor — caught before PROCEED, no escape; behavior restored and re-verified.
- **Fix (applied):** restore the three values; **process fix:** config-migration briefs must paste the verbatim original block, never a keyword-grep summary.

### 2.4 Nits

- The IC's S1-01 proof JSON omitted `schema_version` (PROOF_INVALID); manager verified independently. Future briefs lead the proof snippet with `"schema_version": 1` (already done for S1-02, which passed the gate).
- `llm.finish_step_reason` (per-step Background metric) dropped — RFC-sanctioned (§4.3 drops non-error finish-steps), not test-asserted; documented in `proceed-S1-01.md`.
- The deployed-turn driver lives in `.handoff/` (one-off). If a repeatable deployed smoke is wanted, promote it (backlog).

## 3. Cross-cutting concerns

- **Type safety:** no `any`/`@ts-ignore` in the diff. `history` narrowed `ModelMessage[]` → the `ReasonerMessage` shape — safe (only `{role,content}` text messages are ever stored).
- **Latency (the #1 constraint):** seam-neutral, evidenced over 6 runs at S1-01 + 2 short-fixture runs at S1-02, all within band. The deployed turn is functional-only (not gated) per §7a. **No hard-flag regression.**
- **Edge/deps:** `@ai-sdk/openai` was already in the edge bundle via the old bridge; `verify-edge-bundle.sh` stays clean. One real deploy (user-authorized).
- **Behavior preservation:** the 9 bridge tests are the oracle and are unchanged; the config split preserved every per-site provider value (after the m1 fix), verified against the original blocks.

## 4. Constructive close

Nothing to fix post-review — the one minor (m1) was caught and corrected within Phase A, and its real value is the process lesson (paste verbatim config blocks into migration briefs). The re-home achieved exactly the RFC's safety property: the production bridge now drives a `Reasoner`, is constructed with explicit adapters, runs live on the deployed edge, and is latency-neutral — with *less* code and zero behavior change. No `[S1-fix]` commit warranted beyond `ad65e10` (already in). Proceed to warm-down and Sprint 2 (Mastra adapter).

## 5. Verdict

- [x] **Approve with minor fixes.** No blockers/majors; m1 already fixed in `ad65e10`; nits are forward notes. Sprint 1 is Done.
