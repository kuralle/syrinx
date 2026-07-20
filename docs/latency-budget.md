# Voice-to-Voice Latency Budget (VE-05)

Optimize **P95/P99, not the mean** — "every 10 ms matters." The canonical headline is **v2v = AgentStartedSpeaking − UserStoppedSpeaking** (VAD speech-end → first assistant audio). Per-stage P50/P95/P99 for v2v, STT-final, LLM-TTFT, and TTS-TTFB are reported by `smoke:websocket-interactive` and the interactive baseline artifact.

## Budget table (interactive, streaming Cartesia path)

| Stage | Metric | Target (P95) | Acceptable | Notes |
|---|---|---|---|---|
| STT finalization | speechEnd → sttFinal | ≤ 300 ms | ≤ 600 ms | Deepgram nova-3 streaming; includes endpointing settle |
| LLM time-to-first-token | sttFinal → first LLM delta | ≤ 500 ms | ≤ 900 ms | **Current bottleneck** (measured ~1.3 s) — outside speech scope; depends on model/prompt |
| TTS time-to-first-byte | first LLM delta → first TTS audio | ≤ 300 ms | ≤ 500 ms | Cartesia sonic-3 streaming (measured ~270–320 ms ✓) |
| Playout jitter buffer | client pre-roll | 100–200 ms | — | client `AudioJitterBuffer` (default 100 ms) |
| **Voice-to-voice** | **speechEnd → first audio** | **≤ 800 ms** | ≤ 1500 ms | sum-dominated by LLM-TTFT today |

## Measured baseline (2026-06, gemini-3.1-flash-lite / nova-3 / sonic-3)
- STT-final P50/P95 ≈ 314 / 520 ms ✓ (near target)
- TTS-TTFB P50/P95 ≈ 270 / 317 ms ✓
- LLM-TTFT P50 ≈ 1280 ms ✗ (exceeds 500 ms target — the dominant cost)
- **v2v P50 ≈ 2.1–3.6 s ✗** (exceeds the 800 ms SLO band; LLM-TTFT-dominated)

## Enforcement
`smoke:websocket-interactive` already emits an SLO-band warning when v2v P50/P95 exceed 800 ms (see the run's `qualityGate.failures`). The speech-in/out stages (STT-final, TTS-TTFB) are within budget; the v2v gap is the LLM leg, which is outside VE-01..05 speech scope. Reducing it (smaller/faster model, speculative TTS start on partial LLM text, hedging) is product/LLM work, not speech-engine work.

## SLO definitions (VE-07.4)

Computed from the `MetricsExporter` histograms emitted by `ObservabilityObserver` (VE-07.3), tagged by session/speech id, provider, model, region, and `cancelled`. Cancelled (barge-in) turns are excluded from the latency SLOs and counted toward interruption success instead.

| SLO | Definition | Target | Source |
|---|---|---|---|
| **v2v P95** | `v2v_ms` (user_stopped_speaking → agent_started_speaking), non-cancelled | ≤ 800 ms (warn band) | `v2v_ms` histogram |
| **v2v P99** | as above, P99 | ≤ 1500 ms | `v2v_ms` histogram |
| **Interruption success** | fraction of `interruption` boundaries that reach media-silent within the onset budget | ≥ 95% | `interrupt.onset_to_media_silent_ms` (VE-03.1) |
| **Speech-path error rate** | `stt.error` + `tts.error` + `vad.error` + transport errors per turn (LLM excluded — out of speech scope) | < 1% of turns | error packets / turn count |

These are definitions + targets, not a deployed alerting stack — the export backend (Prometheus/OTel) is an optional implementation package per the VE-07 bridge; `InMemoryMetricsExporter` + `reconstructTurnTimeline` cover local/test/incident drill-down (VE-07.5).

## Where the numbers come from
- Per-stage timings: `TurnMetricsTracker` (`packages/server-websocket/src/turn-metrics.ts`) + the interactive smoke harness + the `obs.turn_boundary` histograms (VE-07.3).
- EOU sub-budget (VAD stop hangover + STT-final delay + endpoint delay + sum): `eouBudgetMs` (VE-02.3).
- Monotonic time source + `cancelled` flag: `observability.ts` `monotonicNowMs` + `ObservabilityObserver` (VE-07), so cancelled attempts never pollute the latency histograms and metrics are exporter-agnostic.

---

## Sprint-1 S1-00 baseline — Reasoner-bridge latency gate denominator (2026-06-05, gpt-4.1-mini)

Captured on `v2` HEAD **before** the `Reasoner` re-home (commit `1db701f`), via `pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-interactive` ×3. This is the **denominator** every Reasoner-bridge latency gate (S1-01, S1-02, S1-03, and Sprints 2–3) compares against per RFC §7a / M3 — *no regression vs our own baseline*, **not** the literature budget and **not** the noisy deployed worker.

**Provider:** OpenAI `gpt-4.1-mini` (bridge default since `35601f6`) / Deepgram `nova-3` / Cartesia `sonic-3`. The prior "Measured baseline (2026-06, gemini-3.1-flash-lite)" section above is **stale** for the LLM leg and is superseded by this for Reasoner-bridge gating.

| Run | LLM-TTFT P50 (ms) | LLM-TTFT P95 (ms) | artifact |
|---|---|---|---|
| 1 | 3733 | 4313 | `test/performance/runs/websocket-university-interactive-2026-06-05T07-28-31-103Z/` |
| 2 | 2773 | 3801 | `…2026-06-05T07-29-51-648Z/` |
| 3 | 3365 | 4018 | `…2026-06-05T07-31-07-990Z/` |
| **mean** | **3290** | **4044** | — |
| min / max | 2773 / 3733 | 3801 / 4313 | — |

**The variance is provider-driven, not harness-driven.** `smoke:websocket-interactive`'s LLM-TTFT stage is a **live OpenAI API call**, so its TTFT carries real provider/network RTT noise — P50 ranged 2773–3733 ms (~±15% around the mean) across three back-to-back runs. By contrast the speech stages were stable (STT-final P50 519–530 ms; TTS-TTFB P50 488–530 ms). The RFC M3 framing assumed this harness yields a *stable* LLM-TTFT; it is stable for the speech stages but **not** for the LLM stage. The gate therefore bands against observed run-to-run variance, not the RFC's aspirational "~5%".

### The gate (assert in S1-01 / S1-02 / S1-03)

> **PASS** iff the post-change `smoke:websocket-interactive` shows **LLM-TTFT P50 ≤ 3920 ms** and **P95 ≤ 4530 ms** (= worst baseline run + 5% headroom).

Rationale: the `Reasoner` seam is a structural passthrough — Sprint 0 proved it adds at most one microtask + a synchronous object remap per part (~microseconds), i.e. < 0.001% of a ~3290 ms LLM-TTFT, invisible against ±1000 ms of live-API noise. The failure mode the gate actually protects against is **accidental buffering** (e.g. awaiting the stream to completion before emitting) — that would balloon LLM-TTFT to full-generation time (seconds), blowing past 3920/4530 ms unmistakably. The real fine-grained protection against behavior drift is the **9 unchanged `index.test.ts` assertions** + the no-buffering unit test, not the absolute millisecond delta. A post-change result *above* the gate that cannot be attributed to provider noise (re-run ×3 to confirm) is a **hard-flag regression** (RFC §7a) — reject the commit, do not merge.

---

## Reasoner-bridge cross-backend latency report (S4-01, 2026-06-05)

Consolidated from the program's per-sprint proceed evidence (this session) — the `Reasoner` seam is a transparent passthrough; **no seam-attributable LLM-TTFT regression on any backend**. Methodology: `smoke:websocket-interactive`, short fixture (`SYRINX_WS_MAX_TURNS=1`) per the credit directive; the LLM leg is a live OpenAI call (network-noisy — see the S1-00 section), so the gate bands against observed variance, not the literature ~350 ms stage budget.

| Backend / stage | LLM-TTFT | vs S1-00 gate (P50 ≤ 3920 / P95 ≤ 4530) | Source |
|---|---|---|---|
| **S1-00 baseline** (pre-refactor, AI-SDK, gpt-4.1-mini) | P50 mean **3290** (3733/2773/3365), P95 mean **4044** (4313/3801/4018) | — (the denominator) | `sprints/sprint-1` |
| **AI-SDK, post-re-home** (`ReasoningBridge` drives the `Reasoner`) | P50 mean **2705** (6 runs), P95 mean **3763** | ✅ within band — *faster* than baseline (a buffering regression would inflate P50) | `proceed-S1-01.md` |
| **Mastra** (Node, gpt-4.1-mini via `fromMastraAgent`) | **2967** / **884** (2 short-fixture runs) | ✅ within band | `proceed-S2-02.md` |
| **Suspend/resume path** (Mastra-on-edge DO) | non-suspending turns: `RunStore.takePending` = one local SQL `SELECT`, no hot-path I/O hop (RFC §7a) | ✅ no added latency on the common path | `proceed-S3-03/04.md` |

**Verdict:** the generalization (AI SDK → Mastra → suspend/resume) is **latency-neutral**. The seam adds at most one microtask + a synchronous object remap per part (Sprint 0's no-buffering unit test + the structural proof); the dominant cost is the LLM provider's TTFT, which is identical across backends at the same model. The ~350 ms literature stage budget (Daily/Modal) is the provider's target, not the seam's — the seam's contribution is below measurement noise. Speech stages (STT-final ~520 ms, TTS-TTFB ~500 ms) are unchanged throughout (they don't route through the bridge).

**Live demos proven (this program):** AI-SDK deployed (`syrinx-voice-server-workers`, Version `cc9236aa`); Mastra Node turn (S2-02) + Mastra-edge deployed (`voice-server-workers-mastra`, Version `40a15353`, Paid tier); suspend→resume by `runId` on the deployed Mastra worker. The Mastra-edge worker's ~249 ms cold-start is a deploy-runtime metric, separate from LLM-TTFT.

---

## Reasoner-latency composite gate (RL-WBS-5, 2026-07-09)

`RoutingReasoner` (Lever B) + `HedgedReasoner` (Lever C) — opt-in composite `Reasoner`s at the seam. Measured LLM-TTFT (reasoner `stream` → first delta) via `examples/02-hello-voice-headless/scripts/bench-reasoner-latency.ts`, gpt-4.1-mini (deep) / gpt-4.1-nano (fast), hedgeAfter 300 ms, 9 measured runs (1 warmup discarded), one long-turn fixture.

| Config | LLM-TTFT P50 | worst-of-9 (≈P95) |
|---|---|---|
| plain `gpt-4.1-mini` | 1005 ms | 6580 ms |
| plain `gpt-4.1-nano` | 1111 ms | 3298 ms |
| **hedged** (mini×2) | 961 ms | **2725 ms** |
| routed (fast/deep) | 991 ms | 4274 ms |
| **composed** (route→hedge) | **869 ms** | 3329 ms |

**Verdict.** **Hedging cuts the tail −59%** (worst-case 6580 → 2725 ms) — the Sierra "hedging → P99 −70%" claim, confirmed live; composed cuts P50 ~14%. **The v2v P50 < 1s headline is NOT met by B+C alone** with these models: LLM-TTFT P50 ~870–1005 ms + STT-final (~400 ms) + TTS-TTFB (~300 ms) ⇒ v2v ≈ 1.5–1.7 s. Getting under 1s requires **Lever D's speculative-start overlap** (already shipped — the `speculative` flag on `ReasoningBridge` over the IU ledger) to hide LLM-TTFT under the STT-settle window, plus model choice; B+C **reduce** latency (tail especially), **D** is what actually clears 1s. Caveats: n=9 (worst-of-9 ≈ P95, noisy); routing's fast-model win was not exercised (the fixture turn is > the classify length threshold → always `deep`, `route.mispredict: 0`) — a short/mixed fixture is needed to measure routing's mean-latency gain. `plain gpt-4.1-mini` here (P50 1005 ms) is faster than the S1-00 baseline (3290 ms) — provider-side improvement, not a seam change.

## Lever D speculative-start live gate + OQ2 (RL-WBS-5 close, 2026-07-11)

The sub-1s claim rests on **Lever D** (speculative-start overlap), not B/C — measured live via `smoke:flux-speculative-ab` (live Deepgram Flux `eager_eot_threshold 0.4` in both arms + live gpt-4o-mini; only the bridge's `speculative` flag differs). Headline metric: **confirmed endpoint (`eos.turn_complete`) → first `llm.delta`** — the residual LLM-TTFT the speculation did *not* hide. 3 A/B runs:

| Run | OFF endpoint→first-token | ON endpoint→first-token | saved |
|---|---|---|---|
| 1 | 1546 ms | 760 ms | 786 ms |
| 2 | 753 ms | 618 ms | 135 ms |
| 3 | 756 ms | 538 ms | 218 ms |
| **median** | **756 ms** | **618 ms** | **~218 ms** |

**OQ2 — interim↔final divergence.** Every run, **both** arms: `1 llm call, eager endpoints 1, resumed 0`. The single eager (interim) endpoint matched the final transcript, so the speculative draft **promoted without regeneration** — **zero divergence-caused rework, zero wasted LLM call** on this clean pause-free utterance. This bounds OQ2's *cost* (nil on a clean turn); it does not characterise divergence across noisy/mid-pause turns (n=1 fixture).

**Verdict (honest close).** Speculative-start (D) beat the plain path on endpoint→first-token in **all 3 runs** (saved 135–786 ms). v2v from the confirmed endpoint ≈ ON first-token (618 ms median) + TTS-TTFB (~300 ms) ≈ **~0.9 s** — **at the edge of the 800 ms SLO / clearing the 1500 ms P99 band**, achieved via **D**, not B/C. This is not a comfortable sub-800 ms; it is D landing v2v right at the 1s line on a clean turn, exactly as the RFC thesis predicts. The composed `route→hedge→speculative` config is drop-in at `withVoice({ reasoner })` (no seam change; see `sprints/reasoner-latency/OUTCOMES.md`). Raw runs: `runs/spec-ab-run{1,2,3}.txt`.

## Scope correction — the ~0.9 s figure is a tool-free number (2026-07-19)

The ~0.9 s above is real but **narrow**, and it has been read as a product claim it does not
support. It was measured on a clean, pause-free, **tool-free** fixture, from the *confirmed
endpoint*, on a single-pass generation. A tool-calling turn is a different animal.

Live decomposition of one real tool-calling cascade turn (Deepgram nova-3 → gpt-4.1-mini +
tools → Cartesia sonic-3, same harness, `turn_latency`):

| stage | ms | share |
|---|---|---|
| `llmTtftMs` | 3539 | 90% |
| `ttsTtfbMs` | 242 | 6% |
| tool execution | ~0 | 0% |
| `unattributedMs` (sentence aggregation) | 333 | 8% |
| **`ttfaMs`** | **4114** | |

Two things this changes:

**Tools are not the cost — extra inference passes are.** Tool execution measured 0–1 ms (the
fixture's tools are local stubs). The 3.5 s is sequential LLM passes: the model cannot answer
before the tool returns, so a grounded answer is gated behind ≥2 round-trips.

**A tool preamble recovers most of the perceived gap.** Asking the model for one short grounded
sentence *before* the tool call moved `ttfaMs` from 3813/4114 ms to 1404/1732 ms (n=2 per arm,
same fixture/tools/model) — with the tool still called and the grounded answer still delivered.
See `runs/phase0-spike-implementation-notes.md` (A8).

**State it honestly.** The preamble does not reduce time-to-**answer**; it reduces time-to-first-
*useful* audio. Any latency number quoted from a turn where a preamble, filler, or backchannel
spoke first must be reported alongside the `fillerUsed` / `backchannelUsed` flags on
`turn_latency`, or it is measuring time-to-acknowledgement and calling it latency — the exact
confound that made the native-realtime arm's "1.3 s" unusable in `docs/interaction-thesis-results.md`.
