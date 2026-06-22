# RFC: Reasoner latency — speculative start, adaptive routing & hedging (closing the v2v gap)

> Status: Draft (2026-06-23). Author: research-led, grounded in the Sierra competitor study
> ([`research/competitors/sierra/`](../research/competitors/sierra/README.md)) and the Syrinx product
> direction ([`research/syrinx-product-direction.md`](../research/syrinx-product-direction.md), Gap 1 — critical path).
> Builds on: `docs/rfc-reasoner-bridge.md` (the `Reasoner` seam) and `docs/latency-budget.md` (VE-05).
> Supersedes the placeholder name `rfc-llm-hedging.md` referenced in the direction doc.

## 1. Context & problem

Latency is the product. The measured reality is that we are **3–4× over our own SLO** and the cost is
entirely in the reasoning hop:

- **v2v P50 ≈ 2.1–3.6 s** vs the **≤ 800 ms** SLO band (`docs/latency-budget.md`).
- Speech hops are healthy: **STT-final P50 ≈ 314–520 ms ✓**, **TTS-TTFB P50 ≈ 270–320 ms ✓**.
- **LLM-TTFT is the dominant, sole bottleneck**: P50 ≈ 1280 ms (gemini-3.1-flash-lite) up to ~3290 ms
  (gpt-4.1-mini), against a ≤ 500 ms target.

`docs/latency-budget.md` §Enforcement names the fix verbatim: *"Reducing it (smaller/faster model,
speculative TTS start on partial LLM text, hedging) is product/LLM work, not speech-engine work."* This RFC
**is** that product/LLM work. The competitor that defines this market (Sierra) reports **P99 −70%** from
request hedging and runs **speculative execution** ("classify and respond at the same time") and **adaptive
model selection** (small/fast for state/classification, frontier for the 1–2 hard inferences) as standard.

The arithmetic that matters: v2v ≈ STT-final + LLM-TTFT + TTS-TTFB is a **serial sum** today
(~520 + ~1280 + ~300 ≈ 2.1 s). No single faster model gets us under 1 s — even flash-lite's ~1280 ms TTFT
alone exceeds the 800 ms v2v budget. **The only way under 1 s is to overlap the serial stages and to cut
the chosen inference's tail.** That is the design goal.

## 2. Goals / non-goals

**Goals**
- Get **v2v P50 < ~1 s** on the standard interactive fixture without regressing correctness or barge-in.
- Do it by **composing the existing `Reasoner` seam**, not rewriting it — composite Reasoners that wrap
  other Reasoners. The cf-agents `withVoice(Agent, { reasoner })` slot is unchanged (composites occupy it).
- Land four independent, individually-measurable levers; ship the cheap/safe ones first.

**Non-goals**
- No model finetuning, no in-house model. No changes to the speech (STT/TTS/VAD) plugins or the transport.
- No changes to `ProviderFallback` (it stays for STT/TTS request/response reconnect — see §3).
- No memory/ADP/no-code work (explicit anti-goals in the direction doc).
- Not chasing absolute parity with a proprietary stack's numbers — chasing **our own 800 ms SLO**.

## 3. Prior art (grounding — read before designing)

- **`packages/core/src/reasoner.ts`** — the seam. `Reasoner.stream(turn): AsyncIterable<ReasoningPart>`
  with the **non-negotiable latency invariant** (§7a of the reasoner RFC): yield every part the instant the
  backend produces it; **no buffering, no awaiting to completion**. `ReasoningPart` ∈ {`text-delta`,
  `tool-call`, `tool-result`, `suspended` (terminal), `error` (terminal), `finish`}. The bridge owns
  history; cancellation is `turn.signal`.
- **`packages/core/src/provider-fallback.ts`** — `ProviderFallback<TReq,TResp>`: **sequential** failover
  (try provider → on throw mark unavailable + schedule a health-probe recovery). It is **request/response,
  not streaming, and not latency-triggered**. It is the *failover* sibling of what we need; hedging is the
  *streaming, threshold-triggered, racing* sibling. We add new primitives; we do not bend this one.
- **`docs/latency-budget.md`** — the SLO definitions, the measured baselines, and the **S1-00 gate
  denominator** (LLM-TTFT P50 mean 3290 ms; the gate is "no regression vs our own baseline", not the
  literature budget). Cancelled (barge-in) turns are excluded from latency SLOs.
- **Sierra competitor study** — `sierra-voice-audio-ux.md` §2.2 (the four parallel-graph techniques:
  parallel execution, predictive prefetch, adaptive model selection, provider hedging) and the
  inference-resilience trilogy in `sierra-competitor-analysis.md` §3.1 (hedging → P99 −70%; EWMA tumbling
  windows; AIMD admission control; **the no-mid-stream-swap rule**).

## 4. Proposed design (summary)

Four levers, composed at the `Reasoner` seam. Today the pipeline is a serial sum; the design overlaps it:

```
TODAY (serial):   [── STT-final ──][──── LLM-TTFT ────][─ TTS-TTFB ─]      v2v ≈ 2.1 s
                  speechEnd                                       first audio

TARGET (overlapped):
  [── STT-final ──]
        └ Lever D: speculative LLM start on stable interim ─►[──── LLM gen ────]
                                                  └ Lever A: TTS starts on 1st delta ─►[audio…]
        Lever B: route simple turns → fast model (shorter TTFT)
        Lever C: hedge the chosen inference → cut the tail (P99)
                  speechEnd ────────────────────────────► first audio   v2v < 1 s
```

- **Lever A — Speculative TTS start (verify/harden).** TTS must begin synth on the **first `text-delta`**,
  not at clause/sentence/turn end. The budget's TTS-TTFB is already measured *from* first LLM delta
  (~270–320 ms), so this is largely in place; WBS-3 confirms it and removes any residual clause-buffering on
  the critical first utterance. *Low risk, may be ~done.*
- **Lever B — Adaptive routing (`RoutingReasoner`).** A fast pre-classifier picks among
  `{ id → Reasoner }` routes per turn (e.g. `fast` = flash-lite for acks/state/FAQ; `deep` = frontier for
  multi-step reasoning). Simple turns (the majority) take the short-TTFT path. *Biggest mean-latency win.*
- **Lever C — Threshold-triggered hedging (`HedgedReasoner`).** Fire a **backup** inference only if the
  primary is silent past `hedgeAfterMs`; **commit to whichever emits the first `ReasoningPart`, abort the
  loser**. Bounded extra cost; targets P99/tail. *Tail-latency win.*
- **Lever D — Speculative LLM start (prefetch on stable interim).** Kick the chosen reasoner off the **last
  stable interim transcript** at/just before endpoint; if the final transcript matches (the common case),
  the inference is already in flight and LLM-TTFT hides under STT-final settle; if it diverges, abort and
  restart. *Highest-leverage and highest-risk — overlaps the two biggest serial stages.*

All four are **opt-in composite Reasoners** living in `packages/core` (pure, no provider deps, alongside
`provider-fallback.ts`). A session given a plain `Reasoner` behaves exactly as today (R8). New interfaces:

```ts
// Lever B
interface ReasonerRoute { readonly id: string; readonly reasoner: Reasoner }
interface RoutingReasonerOptions {
  readonly routes: readonly ReasonerRoute[];
  /** MUST resolve fast (small model / heuristic). Returns a route id. */
  readonly classify: (turn: ReasonerTurn) => string | Promise<string>;
  /** Optional: pre-start this route while `classify` runs; keep it iff classify agrees, else abort+switch
   *  BEFORE any part is forwarded (pre-commit only — R1/R2). */
  readonly speculateRouteId?: string;
}
class RoutingReasoner implements Reasoner { /* stream(turn) */ }

// Lever C
interface HedgedReasonerOptions {
  readonly primary: Reasoner;
  readonly backup: Reasoner;       // same model / different provider, or a peer
  readonly hedgeAfterMs: number;   // fire backup only past this; bounds cost
}
class HedgedReasoner implements Reasoner { /* stream(turn) */ }

// Lever D wires into the bridge/session, not a Reasoner wrapper: it controls WHEN
// reasoner.stream(turn) is invoked (on stable interim) and validates against eos final.
```

The composites are **transparent passthroughs after commit** — same §7a invariant as the seam.

## 5. Hard requirements (non-negotiable correctness)

Every chunk touching these MUST satisfy them; acceptance criteria, not nice-to-haves.

- **R1 (single committed stream — no interleaving).** Once a composite commits to one underlying Reasoner
  for a turn, **every** `ReasoningPart` forwarded for that turn comes from that one backend. Parts from two
  backends are never merged. This is the streaming analog of Sierra's **no-mid-stream-swap** rule.
- **R2 (commit before any side effect).** Commit MUST happen before any part is forwarded downstream **and**
  before any non-committed backend executes a side-effecting tool. Because adapters execute tools *inside*
  the stream (AI-SDK/Mastra tool loops emit `tool-call`→`tool-result`), hedging/routing across a turn that
  can invoke side-effecting tools is **first-inference-only**: commit on the first emitted part and abort
  losers immediately. If a turn's tools are not provably read-only/idempotent and cannot be gated until
  commit, the composite MUST disable speculation/hedging for that turn. (Exact tool-gating mechanism →
  resolve in build, OQ1.)
- **R3 (losers aborted; no leaks).** On commit, abort every non-committed backend via a child of
  `turn.signal`. No orphan provider sockets, no tokens billed after commit beyond the in-flight request that
  is being cancelled. Emit a metric per abort.
- **R4 (latency invariant preserved).** A composite may hold **only the first part** pre-commit (a bounded,
  turn-start hold, never buffering to completion); after commit it is a transparent passthrough adding at
  most one microtask + a synchronous remap per part (reasoner RFC §7a). It MUST NOT inflate LLM-TTFT for the
  non-routed/plain path.
- **R5 (barge-in unaffected).** `turn.signal` abort propagates to the committed backend **and** any
  in-flight losers and any speculative (Lever D) run. The existing bridge barge-in path
  (`interrupt.tts` → `response.cancel`/abort, cancelled turns excluded from latency SLOs) is unchanged.
- **R6 (error / suspended contract).** A **pre-commit** primary `error` may fail over to the backup
  (composes with ProviderFallback semantics). A **post-commit** `error`/`suspended` is forwarded verbatim as
  the terminal part — no swap, no retry-onto-a-different-backend mid-turn.
- **R7 (cost is bounded and reported).** Hedging/speculation burn extra tokens. Hedging is
  threshold-triggered (never always-on) to bound cost; Lever D restart-on-divergence is bounded by interim
  stability. Every composite emits a **fire-rate / waste metric** (hedge-fired %, speculative-discarded %)
  on `Route.Background`, reported next to the latency delta. No "free" claims (R7-honesty mirrors realtime
  RFC R7).
- **R8 (zero behavior change for the plain path).** A `withVoice(Agent, { reasoner })` configured with a
  single plain Reasoner produces byte-identical behavior to today. Composites are strictly opt-in; the
  cf-agents API surface does not change.

## 6. Out of scope / explicitly NOT touched

`ProviderFallback` (stays for STT/TTS); the speech plugins (STT/VAD/TTS) and transport; the `Reasoner`
interface itself (composites *implement* it, don't change it); telephony adapters; model finetuning; AIMD
admission control / endpoint auth (a separate direction-doc workstream — this RFC is latency, not capacity).

## 7. Risks & open questions (resolve during build, not by guessing)

- **OQ1 (tool side-effects under hedging/speculation).** Can we mark tools read-only/idempotent in the
  reasoner adapters so a loser/speculative run never commits a side effect, or must commit always precede
  the first `tool-call`? **Resolve in WBS-1 via a fake-Reasoner test + the AI-SDK tool loop**; default to
  the conservative R2 rule (first-part commit, disable hedging when a turn exposes non-idempotent tools).
- **OQ2 (interim-transcript divergence rate — Lever D viability).** How often does the last stable interim
  differ materially from `eos` final on our fixtures? If divergence is high, Lever D's restart waste
  outweighs the overlap win. **Measure first in WBS-4** from existing smoke transcripts before building the
  hot path; gate Lever D on an observed acceptable divergence rate.
- **OQ3 (classifier latency/quality — Lever B).** The `classify` step must cost < the TTFT it saves. Is a
  heuristic (turn length / tool-presence / keyword) enough, or a tiny model call? Start heuristic; measure;
  upgrade only if mis-routing hurts. A mis-route is a latency/quality cost, never a correctness one (R1).
- **R-risk (cost blow-up).** Always-on hedging doubles inference spend. Mitigated by R7 threshold + metric;
  hedge defaults OFF, enabled per-deployment.

---

## 8. Work breakdown (the delegation plan — build order)

Sequential; each chunk has a **gate** that must pass before the next is delegated. Worker per `/delegate`
directive; **manager reviews the git diff** of each chunk (not the digest) and **runs the live smokes**
(per the manager-runs-smokes rule). Latency gates use the **short fixture** (`SYRINX_WS_MAX_TURNS=1`) to
save provider credits, min 3 runs (the LLM leg is network-noisy — see `latency-budget.md` S1-00).

> Convention every chunk: TypeScript, ESM, vitest, match neighbour style; no kernel edits outside named
> files; green `pnpm -r typecheck` + `pnpm -r test` before "done"; cite the RFC requirement(s) satisfied.

### WBS-1 — `HedgedReasoner` (Lever C) — the safe primitive first
- **Scope (files):** `packages/core/src/reasoner-hedge.ts` (new), `src/index.ts` (export),
  `reasoner-hedge.test.ts`.
- **Read first:** `packages/core/src/reasoner.ts` (the seam + §7a invariant), `provider-fallback.ts`
  (abort/metric conventions to mirror), `packages/aisdk/src/index.ts` (how `ReasoningBridge` drives a
  Reasoner, the `processTurn` switch).
- **Interface:** `class HedgedReasoner implements Reasoner` per §4. Race primary vs (threshold-delayed)
  backup; **commit on the first `ReasoningPart` from either**; abort the loser via a child of `turn.signal`
  (R3); forward the committed stream verbatim (R4). Pre-commit primary `error` → immediately commit backup
  (R6). Emit `hedge.fired` / `hedge.committed_to` metrics (R7).
- **DoD:** unit tests with **two fake Reasoners** proving: (a) primary wins when fast → backup never fired;
  (b) backup fired after `hedgeAfterMs`, primary still wins if it emits first; (c) **no interleaving** —
  parts only ever from the committed backend (R1); (d) loser's `signal` is aborted (R3); (e) pre-commit
  primary `error` fails over (R6); (f) post-commit `error` forwarded verbatim, no failover (R6).
- **Acceptance (gate):** live `smoke:websocket-interactive` with a `HedgedReasoner(primary, backup)` of the
  **same** model/provider shows **LLM-TTFT P95/P99 ≤ the S1-00 baseline** (tail not worse) and no
  correctness regression on the 9 `index.test.ts` assertions. Report `hedge.fired %`.
- **Out of scope:** routing, speculation.

### WBS-2 — `RoutingReasoner` (Lever B) — the mean-latency win
- **Scope:** `packages/core/src/reasoner-route.ts` (new), `src/index.ts`, `reasoner-route.test.ts`.
- **Read first:** WBS-1 output, `reasoner.ts`, an existing example agent
  (`examples/02-hello-voice-headless/scripts/run-university-support-baseline.ts`) for a realistic
  fast-vs-deep split.
- **Interface:** `class RoutingReasoner implements Reasoner` per §4. `classify(turn)` → route id (start with
  a **heuristic**, OQ3); stream the chosen route. Optional `speculateRouteId`: pre-start that route while
  `classify` runs and keep it iff classify agrees, else abort+switch **before any part is forwarded** (R1/R2,
  pre-commit only). Emit `route.selected` + `route.mispredict` (when speculation is discarded) metrics.
- **DoD:** unit tests: correct route chosen per heuristic; speculation kept on agree / aborted-and-switched
  on disagree with **no forwarded part from the discarded route** (R1/R2); plain single-route == passthrough
  (R8).
- **Acceptance (gate):** live mixed fixture (some trivial turns, some reasoning turns) routed `fast`/`deep`
  shows **v2v P50 drop** vs the all-frontier baseline, with answer quality unchanged on the university
  fixture (manager spot-checks transcripts).
- **Out of scope:** speculative LLM start, TTS.

### WBS-3 — Speculative TTS start (Lever A) — confirm & harden
- **Scope:** verification script + any fix in `packages/core/src/tts-clock.ts` / the bridge TTS path
  (`packages/aisdk/src/index.ts` first-delta→TTS wiring). **Read first** before assuming a change is needed.
- **Read first:** `docs/latency-budget.md` (TTS-TTFB is measured from first LLM delta — likely already
  first-delta-triggered), `packages/core/src/latency-filler.ts`, the TTS plugin session lifecycle in
  `packages/tts-core/src/index.ts`.
- **Interface/DoD:** prove via a trace that TTS synth begins on the **first** `text-delta`, not at clause/
  sentence/turn end, on the first utterance of a turn. If already true: document it, no code change, close
  the chunk. If not: start TTS on first delta, keeping barge-in cancel correct (R5).
- **Acceptance (gate):** TTS-TTFB unchanged-or-better; the trace shows first-delta start; barge-in still
  reaches media-silent within budget (existing interruption SLO).
- **Out of scope:** Lever D.

### WBS-4 — Speculative LLM start (Lever D) — measure, then build
- **Scope:** divergence measurement script first; then `packages/core/src/voice-agent-session.ts`
  speculative-invoke path (mint the reasoner run on stable interim, validate against `eos` final).
- **Read first:** `packages/core/src/voice-agent-session.ts` (turn lifecycle, `eos.turn_complete`, contextId),
  the STT plugins' interim/`is_final` emission (`packages/deepgram/src/stt.ts`), blueprint contextId rules.
- **Step 1 (measure — OQ2):** from existing smoke transcripts, compute how often the last stable interim ==
  final (materially). **Gate Lever D on an acceptable divergence rate**; if too high, stop here and document.
- **Interface (if Step 1 passes):** on stable interim near endpoint, start `reasoner.stream(turn')` against
  a fresh speculative contextId; on `eos` final: if it matches, **commit** that in-flight run (LLM-TTFT now
  hidden under STT settle); if it diverges, abort and restart on the final (R1/R2/R3). Barge-in aborts the
  speculative run too (R5). Emit `speculate.kept %` / `speculate.discarded %` (R7).
- **DoD + Acceptance (gate):** unit test for keep-on-match / abort-on-divergence with no double-forwarding;
  live `smoke:websocket-interactive` shows **v2v P50 reduced** by ~the overlapped STT-final window on
  matching turns, with no correctness/barge-in regression and discarded-rate within the OQ2 bound.
- **Out of scope:** the headline gate (WBS-5).

### WBS-5 — Compose, gate to < 1 s, document
- **Scope:** wire the levers into `withVoice` options (cf-agents) behind config; `packages/core/README` +
  `docs/latency-budget.md` update; a `run-reasoner-latency.ts` report script.
- **Read first:** `packages/cf-agents/src/with-voice.ts` / `build-session.ts` (the `reasoner` slot — R8),
  `docs/latency-budget.md` (the gate denominator + SLO table).
- **Interface/DoD:** a composed config (Route fast/deep + hedge the chosen + speculative start) runnable via
  `withVoice`; the report script prints v2v + per-stage P50/P95/P99 **and** the cost metrics
  (hedge-fired %, speculative-discarded %, mispredict %).
- **Acceptance (gate — the headline):** on the standard interactive fixture, **v2v P50 < ~1 s** (≥3 runs,
  short fixture) with: R1–R8 satisfied; barge-in interruption SLO ≥ 95% unchanged; answer quality unchanged
  on the university fixture; **cost delta documented** (not hidden). Update `latency-budget.md` with the new
  measured baseline. Manager writes `reasoner-latency-manager-notes.md`.

---

## 9. Verification ladder (definition of "done" for the whole RFC)

1. `pnpm -r typecheck` + `pnpm -r test` green across the workspace.
2. WBS-1…2 gates passed (hedge race correctness + no-interleave; routing mean-latency drop).
3. WBS-3 confirms first-delta TTS start (or fixes it); barge-in SLO intact.
4. WBS-4 OQ2 measured and Lever D either shipped (within divergence bound) or documented-and-deferred.
5. **WBS-5 headline gate: v2v P50 < ~1 s on the standard fixture**, R1–R8 satisfied, cost delta documented,
   `latency-budget.md` baseline updated (observed end-to-end per CONTRIBUTING's bar — not assumed).
6. Manager notes written; no `as any` packet bypasses; the plain-Reasoner path proven byte-identical (R8).

> The win condition is our **own 800 ms SLO band**, demonstrated on the harness — not a literature number
> and not a claim. If a lever can't be shown to move v2v on the harness, it doesn't ship.
