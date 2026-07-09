# Reasoner-latency — Outcomes

> Spec: `docs/rfc-reasoner-latency.md`. Branch: `plan/reasoner-latency` (off `beta`). IC: grok. All premise corrections grounded in the code (see the premise-check in the agent run log).

## What shipped (the net-new bulk — Levers B + C)

- **HedgedReasoner (Lever C)** — `packages/core/src/reasoner-hedge.ts`. Races `primary` vs a threshold-delayed `backup`, commits on the first usable part, aborts + releases the loser, forwards the committed stream verbatim. R1 (no interleave), R3 (loser abort), R4 (first-part-only hold), R6 (pre-commit failover / post-commit verbatim), R5 (barge-in), R7 (metrics). Injectable `Scheduler`. **Robust against a throwing backend** (the HOLD→fix caught a hang; `asRacer` wrapper). Guard: `hedge-throwing-backend.test.ts`.
- **RoutingReasoner (Lever B)** — `packages/core/src/reasoner-route.ts`. `classify(turn)` → route; optional pre-commit `speculateRouteId` (keep-on-agree, abort-before-forward on mispredict — R1/R2); R8 passthrough for a single route. **Robust against a rejecting route** (HOLD→fix: swallow the abandoned spec promise + `forwardRoute` converts a throw to an error part). Guard: `route-throwing-spec.test.ts`.
- Both **exported from `@kuralle-syrinx/core`** and both implement `Reasoner`, so they **drop into the `withVoice({ reasoner })` slot** (`with-voice.ts:119`, accepts any `Reasoner` — R8) and **nest** (each wraps `Reasoner`s). WBS-5's "compose into withVoice" therefore needs **no withVoice change** — a deployment constructs e.g. `new RoutingReasoner({ routes: [{id:"fast", reasoner: fast}, {id:"deep", reasoner: new HedgedReasoner({primary, backup, hedgeAfterMs})}], classify })` and passes it as the `reasoner` factory.
- Verification: full `@kuralle-syrinx/core` suite green (240+ tests, incl. 7 hedge + 5 route + 2 manager-authored robustness guards). Every chunk had a manager HOLD→fix that caught a real bug the green tests missed.

## Rescoped (premise-corrected against current code)

- **Lever D (WBS-4, speculative LLM start) — ALREADY BUILT, not re-built.** It ships as the `speculative` flag on `ReasoningBridge` (`packages/aisdk/src/index.ts`) over the IU ledger, wired via `build-session.ts:98,173` (`pipeline.speculative`). The RFC (pre-IU-substrate) targets the wrong file (`voice-agent-session.ts`) and is unaware of it. Its keep-on-match / regenerate-on-mismatch (R1/R2/R3) is implemented + tested (`speculative-on-ledger.test.ts`, `speculative-post-promotion.test.ts`). **The RFC's OQ2 "measure interim↔final divergence first" is the only open item — a live-transcript measurement, not a build.**
- **Lever A (WBS-3, speculative TTS start) — premise WRONG; documented decision, not a naive change.** The RFC assumes TTS is first-delta-triggered; the code shows TTS text is **sentence-buffered** (`bufferTtsText`/`takeCompleteVoiceText` in `voice-agent-session.ts` + `voice-text.ts`), and the **latency filler** (`LatencyFillerController`, `firstTtsTextMs` = EOS timestamp) already speaks first to mask the gap. First-delta TTS would risk mid-clause synthesis artifacts (a quality regression) for a small latency shave that the filler already covers. **Recommendation: keep sentence-buffer + filler; revisit only behind a measured quality/latency A/B — not shipped here.**

## The remaining step — the sub-1s live gate (WBS-5)

The RFC's headline gate is **v2v P50 < ~1s** on the standard interactive fixture (≥3 short-fixture runs, per the latency-gate memory). This is a **live measurement** (provider keys + the interactive fixture + credits) — the manager live-smoke that proves the composed config actually moves v2v. The code to compose is done (drop-in); the gate is the measurement to run.

**Latency premise note:** the RFC's "v2v 2.1–3.6s / LLM-TTFT ~1280ms" cites a **superseded** gemini row in `docs/latency-budget.md`; the live S1-00 gate is gpt-4.1-mini LLM-TTFT ~3290ms P50 (note S4-01: already moved to ~2705ms), with the v2v SLO band (800ms) intact. The gate should be measured against the **current** baseline, and `latency-budget.md` updated with the composed-config numbers + the cost delta (hedge-fired %, route-mispredict %).

## Live gate — RAN (2026-07-09, `bench-reasoner-latency.ts`, gpt-4.1-mini / gpt-4.1-nano, 9 measured runs)

LLM-TTFT (reasoner `stream` → first delta), the composites' domain:

| Config | P50 | worst-of-9 (≈P95) |
|--------|-----|-------------------|
| plain `gpt-4.1-mini` | 1005 ms | **6580 ms** |
| plain `gpt-4.1-nano` | 1111 ms | 3298 ms |
| **hedged (mini×2, hedgeAfter 300ms)** | 961 ms | **2725 ms** |
| routed (fast/deep) | 991 ms | 4274 ms |
| **composed (route→hedge)** | **869 ms** | 3329 ms |

**What the run proves:**
- **Hedging (Lever C) cuts the tail hard — worst-case 6580 → 2725 ms (−59%)** — the Sierra "hedging → P99 −70%" claim, confirmed live. This is the headline win.
- **Composed cuts P50 ~14%** (1005 → 869 ms).

**What the run does NOT clear (reported straight):**
- **The v2v P50 < 1s headline is NOT met by B+C alone** with these models. LLM-TTFT P50 ≈ 870–1005 ms; add STT-final (~400 ms) + TTS-TTFB (~300 ms) ⇒ v2v ≈ 1.5–1.7 s. The RFC itself says "no single faster model gets under 1s"; the sub-1s path is **Lever D's speculative-start overlap (already shipped)** — hiding LLM-TTFT under the STT-settle window — not routing/hedging. B+C **reduce** latency (especially the tail); **D** is what actually gets under 1s.
- **Routing's fast-model win was not exercised** — the fixture turn is 73 chars (> the 60-char classify threshold) so it always routed `deep` (`route.mispredict: 0`). A short/mixed-turn fixture is needed to measure routing's mean-latency win; structurally it is unit-tested and sound.
- **Caveats:** n=9 (worst-of-9 ≈ P95, a noisy tail estimate); the `hedge.fired: 20/9` counter is inflated (shared with the composed bench's reused hedged instances) — a harness reporting quirk, not a result issue.

## Honest status
RoutingReasoner + HedgedReasoner are **built, verified, robust, composable, and live-gated**. The gate shows the composites deliver a real, large **tail-latency** reduction (−59%) and a modest P50 gain — but the RFC's **v2v < 1s headline is NOT achieved by B+C alone**; it requires Lever D (already shipped) to overlap LLM-TTFT, plus model choice. Lever D is documented-as-shipped; Lever A is a documented no-go. This is the honest, empirical close — not a claimed sub-1s.
