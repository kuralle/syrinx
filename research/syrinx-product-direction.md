# Syrinx — Product Direction

> **Date:** 2026-06-22.
> **Derived from:** the Sierra.ai competitor study ([`research/competitors/sierra/`](./competitors/sierra/README.md)) cross-referenced against an evidence-grounded inventory of the current Syrinx codebase (v3.1.0).
> **Audience:** Syrinx maintainers. This is a strategy doc, not a spec — the critical-path workstream (LLM hedging + adaptive routing) should graduate to its own RFC.

---

## 0. The thesis, in one sentence

**Be the voice transport + ASR layer that actually hits sub-1s and demonstrably wins the "authentication-in-noise" battle — provider-neutral, self-hostable, and ownable — the layer Sierra and everyone else has to buy because nothing on the market is good enough.**

We do **not** chase Sierra up the stack. We out-obsess them on the one layer they consider solved-by-buying.

---

## 1. The uncomfortable headline: we are failing our own core promise

Latency is the *entire* reason this project exists. Sierra's Head of Product says their harness "looks nothing like a standard agent harness" for exactly one reason — *"if you're not responding in 1 or 2 seconds, people wonder where you went."* Latency is not a feature of Syrinx; it is the product.

**Measured reality (2026-06 baseline, gpt-4.1-mini / nova-3 / sonic-3):**

| Hop | Measured | Budget (P95) | Verdict |
|---|---|---|---|
| STT finalization | P50 314–520 ms | ≤300 ms | ✅ healthy |
| TTS TTFB | P50 270–320 ms | ≤300 ms | ✅ healthy |
| **End-to-end v2v** | **P50 ≈ 2.1–3.6 s** | **≤800 ms** | ❌ **3–4× over budget** |

The speech hops are fine. **The reasoning hop is blowing the budget, and the latency map is explicit that v2v is LLM-TTFT-dominated.** We have the world-class instrumentation (per-hop tracing, latency budget, latency-filler) — we are just not hitting the number that justifies the project. *That is the #1 problem, ahead of every feature gap below.*

> Source: `docs/latency-budget.md`; `packages/server-websocket/src/turn-metrics.ts`.

---

## 2. What we already have (protect, don't re-litigate)

The codebase inventory shows Syrinx is a **real, sophisticated voice engine**, at or near parity with Sierra on the transport plumbing they treat as table stakes:

- **Transport** — resumable binary-envelope WebSocket (`syrinx.audio.v1`), jitter buffer, Opus, turn/session state machine. `docs/websocket-audio-protocol.md`, `packages/core/src/voice-agent-session.ts`.
- **Turn-taking — better than "50 lines of glue."** Silero VAD + Pipecat SmartTurn + `PrimarySpeakerGate` + barge-in with fresh `contextId` per turn. `packages/core/src/turn-arbiter.ts`, `primary-speaker-gate.ts`.
- **Latency instrumentation** — per-hop tracing, TTFA-style v2v metric, latency budget + gate, latency-filler (the "spoken loading spinner"). *This is our Agent-Traces/TTFA discipline — Sierra preaches it, we have it.*
- **Bi-model RealtimeBridge** — gpt-realtime front + async reasoner back. *This is precisely Sierra's "pipe input audio + context into the audio model for the last mile" pattern.* `packages/realtime/src/realtime-bridge.ts`, `bi-model-research/blueprint.md`.
- **Provider breadth** — 6+ ASR/TTS adapters (Deepgram nova-3, Cartesia sonic-3, Google, Grok, Gemini, Epsilon).
- **Telephony** — Twilio / Telnyx / SmartPBX, live-smoke tested.
- **Eval seed** — VE-01 proof harness, latency gate, ~58 live smokes, recorder-coherence (Whisper QA).
- **The structural moat Sierra cannot match — open-source, self-hostable, provider-neutral.**

**Implication:** we don't need to *build* the transport layer. We need to make it (a) fast enough and (b) demonstrably better at the hard parts.

---

## 3. The gaps that matter — ranked by leverage

Each gap is grounded in the codebase inventory and targeted against a **number Sierra has publicly published** (so progress is measurable against the market leader, not a vibe).

### Gap 1 — The LLM hop has no hedging or adaptive routing *(critical path)*
**State:** `ProviderFallback` exists but is STT/TTS reconnect only; the LLM is **single-reasoner-per-session, no hedging, no admission control, no adaptive model selection** (`packages/core/src/provider-fallback.ts`).
**Sierra's published fix (the inference-resilience trilogy):**
- **Request hedging** — fire a backup request only if the primary crosses a latency threshold → **P99 −70%.**
- **Adaptive model selection** — small/fast model for state/summary/classification, large model only for deep reasoning.
- **Speculative execution** — look up the answer before deciding you need it; classify and respond in parallel.
- **Behavior-preserving failover** — MMR (per-task model ordering) + AIMD/TCP-style admission control + **never swap mid-stream** (a streamed TTS/LLM response already begun must not change models).
**Why #1:** it directly moves the one metric we are failing. **Exit criterion: v2v P50 < ~1s on the standard fixture.**

### Gap 2 — No ASR ensembling, no context biasing *(highest-value differentiator)*
**State:** 6 ASR providers wired, but **one runs per session.** No parallel ensembling, no silence-arbitration, no CRM/conversation context injection.
**Sierra's published fix (their single biggest *quantified* moat):** query providers in parallel → custom merge (**not** best-of, **not** majority vote) + earlier-turn signals + **inject the expected value to "collapse the search space."** Results: **UER −25–37%, input verification +25%, major transcription errors −15%.**
**Why this is the wedge:** it attacks the **#1 failure mode Sierra publicly admits is unsolved** — *authentication / spelling names, emails, confirmation codes over noisy audio* (the dominant error in τ-voice). A provider-neutral layer that **demonstrably nails confirmation codes in noise** is sharp, ownable, and demoable. **Adopt UER (not WER) as the headline metric.** **Exit criterion: measurable UER reduction vs best single provider on a noisy-auth fixture.**

### Gap 3 — The eval harness measures speed, not task completion under messy audio
**State:** VE-01 + latency gate are latency-only; no adversarial conditions, no task-completion scoring.
**Sierra's open artifacts to run:** `sierra-research/tau2-bench` (τ-voice: 200ms-tick full-duplex, persona mock-users by goal/mood/patience, **G.711 8kHz + Gilbert–Elliott frame drops + noise muddying**, DTMF, DB-state scoring) and `sierra-research/mu-bench` (the UER benchmark).
**The play:** run both against the Syrinx stack and **publish the numbers.** It's a quality engine *and* a credibility/marketing move no closed competitor can match cheaply. Extends VE-01 and the existing latency-gate fixtures. **Exit criterion: a published Syrinx scorecard on τ-voice + μ-bench.**

### Secondary gaps (real, but after 1–3)
- **Turn-taking as a learned, concurrent policy.** We're past glue, but Sierra's edge is a turn policy evaluated ~2s *in parallel with generation* that classifies **interruption vs backchannel vs side-conversation.** Grow `PrimarySpeakerGate` toward that.
- **Mid-call language switching — absent** (`gemini-translate` is one-shot). Given the **Sinhala/Tamil/Epsilon** niche, this is a gap *and* a differentiation opportunity at once.
- **Secure-mode / DTMF capture — absent.** A "drop-the-LLM → deterministic server sequence → DTMF capture → return only status" seam is pure transport and a clean primitive (Sierra's PCI pattern). DTMF capture alone is worth shipping.
- **Endpoint auth / tenancy / cost — absent** (README warns endpoints are unauthenticated). Not a differentiator, but a hard deployment blocker; pairs naturally with the admission-control work in Gap 1.

---

## 4. Anti-goals — what we will deliberately NOT build

Sierra is racing *up-stack* precisely because they consider the transport layer solved-by-buying. Our entire opening is to out-obsess them below. So we will **not**:

- ❌ Build a memory/identity engine (ADP equivalent). **Memory stays deferred to the agent layer (Kuralle) — that is the correct call.** We expose the auth/identity *signal* the agent layer needs; we do not own the store.
- ❌ Build no-code Journeys / Ghostwriter / an agent-authoring product.
- ❌ Build outcome-based-pricing / attribution infrastructure.
- ❌ Build multimodal/visual input.

Every one of those is Sierra's lane. Staying out of them is not under-ambition — it is the strategy.

---

## 5. The roadmap — one, two, three

A deliberately short, measurable sequence. Each step maps to a number Sierra published.

| # | Workstream | Exit criterion | Maps to Sierra's number |
|---|---|---|---|
| **1** | **LLM hedging + adaptive model selection + speculative execution** (critical path → [`docs/rfc-reasoner-latency.md`](../docs/rfc-reasoner-latency.md)) | **v2v P50 < ~1s** on the standard fixture; no mid-stream model swaps | P99 −70% via hedging |
| **2** | **ASR ensembling + context biasing + read-back recovery** | Measurable **UER** reduction vs best single provider on a noisy-auth fixture | UER −25–37%, verification +25% |
| **3** | **τ-voice + μ-bench harness, run against Syrinx, results published** | A public Syrinx voice scorecard | The benchmarks Sierra open-sourced |

Then, in priority order: concurrent turn-policy, mid-call language switching (Sinhala-first), secure-mode/DTMF, endpoint auth.

**The logic of the order:** Step 1 is the difference between Syrinx being a demo and being the thing it claims to be (latency is the thesis). Step 2 is the differentiating wedge against the gap Sierra *admits* is open. Step 3 turns 1 and 2 into provable, publishable credibility. One → two → three.

---

## 6. Capability scorecard (Syrinx today vs Sierra)

| Axis | Syrinx | Sierra | Direction |
|---|---|---|---|
| Transport (resumable WS, jitter, Opus) | ✅ HAVE | ✅ | parity — hold |
| Turn-taking / barge-in | ✅ HAVE (Silero+SmartTurn+gate) | ✅ (custom VAD + concurrent policy) | grow toward learned concurrent policy |
| Latency instrumentation | ✅ HAVE | ✅ (Agent Traces) | parity — hold |
| **End-to-end v2v latency** | ❌ **2.1–3.6s** | ✅ 1–2s | **Gap 1 — critical** |
| **LLM hedging / adaptive routing** | ❌ ABSENT | ✅ (P99 −70%) | **Gap 1 — critical** |
| **ASR ensembling + context biasing** | ❌ ABSENT | ✅ (UER −25–37%) | **Gap 2 — wedge** |
| Multi-provider adapters | ✅ HAVE (6+) | ✅ (multi-home) | parity — hold |
| Bi-model (realtime front + reasoner back) | ✅ HAVE | ✅ (last-mile pattern) | parity — polish |
| **Adversarial voice eval (τ-voice/μ-bench)** | ❌ latency-only | ✅ (open source) | **Gap 3 — credibility** |
| Mid-call language switching | ❌ one-shot only | ✅ | secondary (Sinhala edge) |
| Secure-mode / DTMF capture | ❌ ABSENT | ✅ (PCI L1) | secondary |
| Telephony (Twilio/Telnyx/SIP) | ✅ HAVE | ✅ | parity — hold |
| Memory / identity engine | ⚪ deferred to Kuralle | ✅ (ADP) | **anti-goal — keep deferred** |
| No-code authoring / Ghostwriter | ⚪ none | ✅ | **anti-goal** |
| Open-source / self-hostable / neutral | ✅ **WIN** | ❌ proprietary | **the moat — protect** |

---

## 7. Sources

- Competitor study: [`research/competitors/sierra/sierra-competitor-analysis.md`](./competitors/sierra/sierra-competitor-analysis.md), [`sierra-voice-audio-ux.md`](./competitors/sierra/sierra-voice-audio-ux.md), [`references.md`](./competitors/sierra/references.md) (verified papers).
- Syrinx state: codebase inventory (2026-06-22) — `docs/latency-budget.md`, `docs/websocket-audio-protocol.md`, `docs/rfc-reasoner-bridge.md`, `docs/rfc-realtime-bridge.md`, `bi-model-research/blueprint.md`, `PROVIDER-TESTING.md`, `packages/core/src/*`.
- Open benchmarks to run: `github.com/sierra-research/tau2-bench`, `github.com/sierra-research/mu-bench`.
