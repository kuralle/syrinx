# WBS — Reasoner-latency (routing + hedging)

> Spec: `docs/rfc-reasoner-latency.md`. Build branch: `plan/reasoner-latency` (off `beta`). IC: grok. Manager runs live smokes.
> **Premise-corrected (2026-07-09) — the RFC (2026-06-23) predates the IU substrate:**
> - **Lever D (WBS-4, speculative LLM start) is ALREADY BUILT** — the `speculative` flag on `ReasoningBridge` (`packages/aisdk/src/index.ts`) over the IU ledger, wired via `build-session.ts`. RFC WBS-4 targets the wrong file (`voice-agent-session.ts`) and is unaware of it. → **rescope to measure/gate, not build.**
> - **Lever A (WBS-3) premise is WRONG** — TTS is **sentence-buffered** (`bufferTtsText`/`takeCompleteVoiceText` in `voice-agent-session.ts`), not first-delta; the latency filler masks it. → careful investigation + documented decision, not a naive "confirm".
> - **Levers B (RoutingReasoner) + C (HedgedReasoner) are genuinely ABSENT** = the honest net-new bulk.
> - Reasoner seam (`reasoner.ts` §7a invariant), `ProviderFallback` (metric via `bus.push(Route.Background, make.metric(...))`, injectable `Scheduler`), and the `withVoice({ reasoner })` slot (`with-voice.ts:119`) all match the RFC.
> - Latency premise: the RFC cites a superseded gemini row; the live S1-00 gate is gpt-4.1-mini LLM-TTFT ~3290ms P50; the v2v SLO band (800ms) is intact (`docs/latency-budget.md`).

## Hard requirements (RFC §5 — every composite satisfies)
R1 single committed stream (no interleaving) · R2 commit before any side effect · R3 losers aborted (child of `turn.signal`), no leaks · R4 latency invariant (hold only the first part pre-commit; transparent passthrough after) · R5 barge-in unaffected · R6 error/suspended contract (pre-commit error may fail over; post-commit forwarded verbatim) · R7 cost bounded + reported (metrics) · R8 zero behavior change for the plain single-Reasoner path.

## Sprints

| # | Chunk | Files | Status |
|---|-------|-------|--------|
| 1 | **HedgedReasoner (Lever C)** — the safe primitive first | `packages/core/src/reasoner-hedge.ts` (+ index export, test) | in progress |
| 2 | **RoutingReasoner (Lever B)** — biggest mean-latency win | `packages/core/src/reasoner-route.ts` (+ export, test) | todo |
| 3 | **Rescope D + A** — measure the existing speculative path (divergence); investigate first-delta TTS vs the sentence-buffer/latency-filler (documented decision) | measurement script; docs | todo |
| 4 | **Compose + gate** — wire B+C into `withVoice({ reasoner })` (+ note D is a `pipeline.speculative` flag, a different seam); gate v2v P50 < ~1s (≥3 short-fixture runs); cost delta; update `latency-budget.md` | `cf-agents/src/with-voice.ts`, report script | todo |

Each chunk: behavior-preserving where it touches existing code; the plain-Reasoner path stays byte-identical (R8); `pnpm --filter @kuralle-syrinx/core typecheck && test` green before done; manager verifies by re-run.
