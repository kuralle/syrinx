# RFC amendment — Reasoner-latency (what was built + how to test/baseline)

**Amends:** `docs/rfc-reasoner-latency.md` (Draft 2026-06-23) · **Author:** Opus 4.8 (1M) · **Date:** 2026-07-09 · **Status:** built + live-gated (on `beta`, PR #24)

The RFC predates the IU substrate; several premises are stale. This amendment records what was actually built, the honest gate result, and — the part the RFC lacked — **how to run the tests and re-establish the latency baseline**.

## 1. Premise corrections (verified against current code)

| RFC item | Reality | Action |
|----------|---------|--------|
| **Lever D — speculative LLM start (WBS-4)** — "measure OQ2, then build in `voice-agent-session.ts`" | **Already shipped** as the `speculative` flag on `ReasoningBridge` (`packages/aisdk/src/index.ts`) over the IU ledger, wired via `build-session.ts` (`pipeline.speculative`). Keep-on-match/regenerate-on-mismatch (R1/R2/R3) implemented + tested. | **Not rebuilt.** Only its OQ2 (interim↔final divergence) is open — a live-transcript measurement. |
| **Lever A — speculative TTS start (WBS-3)** — "confirm & harden, likely ~done" | **Premise wrong.** TTS is **sentence-buffered** (`bufferTtsText` / `takeCompleteVoiceText` in `voice-agent-session.ts` + `voice-text.ts`), masked by the **latency filler**. First-delta TTS trades quality (mid-clause artifacts) for a shave the filler already covers. | **Documented no-go**; revisit only behind a measured quality/latency A/B. |
| **Latency premise** — "v2v 2.1–3.6 s, LLM-TTFT ~1280 ms" | Cites a **superseded** gemini row in `latency-budget.md`. The live S1-00 gate is gpt-4.1-mini LLM-TTFT ~3290 ms P50 (note S4-01: ~2705 ms); v2v SLO band 800 ms intact. | Gate against the **current** baseline. |

## 2. What shipped (Levers B + C)

- **`HedgedReasoner`** (`packages/core/src/reasoner-hedge.ts`, Lever C) — race primary vs threshold-delayed backup; commit-on-first; abort loser; forward verbatim; R1–R8; injectable `Scheduler`; robust against a throwing backend. Tests: `reasoner-hedge.test.ts` + `hedge-throwing-backend.test.ts`.
- **`RoutingReasoner`** (`packages/core/src/reasoner-route.ts`, Lever B) — `classify(turn)`→route; optional pre-commit speculation (abort-before-forward on mispredict); R8 passthrough; robust against a rejecting route. Tests: `reasoner-route.test.ts` + `route-throwing-spec.test.ts`.
- Both exported from `@kuralle-syrinx/core`; both implement `Reasoner` → **drop into the `withVoice({ reasoner })` slot (R8) and nest**. No `withVoice` change needed to compose.

## 3. Live gate verdict (RL-WBS-5)

Hedging cuts the LLM-TTFT **tail −59%** (worst-of-9 6580→2725 ms); composed P50 −14% (1005→869 ms). **The v2v P50 < 1s headline is NOT met by B+C alone** — LLM-TTFT ~870–1005 ms + STT (~400 ms) + TTS (~300 ms) ≈ 1.5–1.7 s v2v. The sub-1s path is **Lever D's overlap** (already shipped), not B+C. Full table: `docs/latency-budget.md` § RL-WBS-5.

---

## 4. How to test + establish the baseline (the runbook)

### 4.1 Unit correctness (no keys, fast)
The composites' correctness is proven by unit tests — run before/after any change:
```bash
pnpm --filter @kuralle-syrinx/core test        # 240+ tests incl. the 4 composite suites
pnpm --filter @kuralle-syrinx/core typecheck
```
Key suites: `reasoner-hedge.test.ts` (R1/R3/R4/R6 race + metrics), `reasoner-route.test.ts` (classify/speculation/R8), and the two **robustness guards** `hedge-throwing-backend.test.ts` / `route-throwing-spec.test.ts` (a rejecting backend must not hang or leak an unhandled rejection — these caught the real bugs). These are the regression baseline for the composites; they must stay green.

### 4.2 Latency gate — reasoner leg (live, cheap, the RL-WBS-5 baseline)
Measures LLM-TTFT (`stream`→first delta) for plain vs hedged vs routed vs composed. This is the composites' domain (they only touch the LLM leg).
```bash
# .env must have OPENAI_API_KEY. ~50 short-prompt calls (fractions of a cent).
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:reasoner-latency-gate
```
Knobs (env): `SYRINX_LLM_MODEL` (deep, default `gpt-4.1-mini`), `SYRINX_LLM_FAST_MODEL` (default `gpt-4.1-nano`), `SYRINX_HEDGE_AFTER_MS` (default 300), `SYRINX_BENCH_RUNS` (default 10, 1 warmup discarded).

**Establishing / re-establishing the baseline:**
1. Run it ≥3 times (the LLM leg is network-noisy — see `latency-budget.md` S1-00). Record the `plain(deep)` P50/tail as the **baseline denominator**.
2. Compare `hedged` and `composed` against it: hedging should cut the **tail** (worst-of-N); composed should hold-or-cut **P50**.
3. Paste the run output into `docs/latency-budget.md` (new dated § like RL-WBS-5) — that section IS the recorded baseline for the next change to gate against.
4. **Caveats to note every time:** small N ⇒ "P95" ≈ worst-of-N (noisy); routing's fast-turn win only shows on a **short** turn (< the 60-char classify threshold) — the default long fixture always routes `deep` (`route.mispredict: 0`), so add a short-turn run to measure routing.

### 4.3 Full v2v gate (live, the RFC headline — not met by B+C)
The end-to-end v2v P50 < 1s gate needs the whole STT+LLM+TTS pipeline with a composed reasoner:
```bash
SYRINX_WS_MAX_TURNS=1 pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-interactive
```
Inject a composed reasoner via the `withVoice({ reasoner })` factory (construct `new RoutingReasoner({ routes:[…, {id:"deep", reasoner: new HedgedReasoner({primary, backup, hedgeAfterMs})}], classify })`). Read `turn_latency` for the v2v decomposition. **Expect >1s with gpt-4.1-mini** (LLM-TTFT dominates) — sub-1s requires enabling **Lever D** (`speculative: true` on the pipeline) to overlap LLM-TTFT under STT settle, and/or a faster model. Gate against the S1-00 denominator, not the literature 800 ms, and re-run ×3.

### 4.4 The rule (RFC §7a)
A post-change LLM-TTFT result **above** the recorded baseline band that cannot be attributed to provider noise (re-run ×3 to confirm) is a **hard-flag regression** — reject, do not merge. The seam is a structural passthrough; the failure mode the gate protects against is accidental buffering (which balloons TTFT to full-generation time).
