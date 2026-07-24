# Reasoner-latency v2v<1s gate + OQ2 — implementation notes (2026-07-11)

Task `fed232e1` — a **measurement, not a build**. The composites (B route + C hedge)
were already live-gated 2026-07-09 (see `docs/latency-budget.md` §RL-WBS-5). Remaining:
the Lever-D speculative-start end-to-end measurement + OQ2.

## Load-bearing decision
Did **NOT** re-run `smoke:reasoner-latency-gate` (bench-reasoner-latency) — it already
ran 2026-07-09 (9 runs, documented). Re-running burns credits for data we have
(command-efficiency rule + `latency-gate-short-fixtures` memory). B+C alone are known
not to clear <1s; the sub-1s lever is **D** (speculative-start), which `bench-reasoner-latency`
does NOT exercise. So the correct gate to run was `smoke:flux-speculative-ab` — the live
speculative OFF/ON A/B — which measures D directly and yields the OQ2 counters.

## What ran
`smoke:flux-speculative-ab` × 3 (live Deepgram Flux + live gpt-4o-mini). Both arms identical
except the `ReasoningBridge` `speculative` flag. Metric = confirmed endpoint → first `llm.delta`.

## Results (all 3 PASS)
- endpoint→first-token: OFF median 756 ms → ON median 618 ms; saved 135–786 ms.
- OQ2: every run+arm `eager 1 / resumed 0 / llmCalls 1` → interim endpoint matched final,
  speculative draft promoted with **zero regeneration** (nil cost on a clean turn). n=1 fixture,
  so this bounds OQ2 cost on a clean utterance, not its distribution across noisy turns.
- v2v from confirmed endpoint ≈ 618 ms (ON first-token) + ~300 ms TTS-TTFB ≈ **~0.9 s** — at the
  1s line, achieved via D. Honest close: not a comfortable sub-800 ms; D lands v2v right at the
  line, as the RFC thesis predicts. Consistent with OUTCOMES' "not a claimed sub-1s."

## Action items status
1. Compose route→hedge→speculative — drop-in, no code change (OUTCOMES-documented); D exercised
   end-to-end here, B+C in the 2026-07-09 bench. ✅
2. v2v gate ≥3 runs — ✅ (3 A/B runs).
3. OQ2 — ✅ (nil divergence/regeneration on the fixture).
4. `docs/latency-budget.md` updated with the D numbers + OQ2 + cost delta. ✅

Raw: `runs/spec-ab-run{1,2,3}.txt`.
