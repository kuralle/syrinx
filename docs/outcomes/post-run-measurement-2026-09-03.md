# Outcomes: post-run measurement — 2026-09-03

Measured after the eight-commit autonomous run (`05b0025` … `10214a2`), comparing the
pre-run tree `5797fc2` ("before") against `main` at `10214a2` ("after"). Every number
below was produced tonight on one machine with the provider set in `.env`; the raw logs
are under `runs/latency-ab-2026-09-03/` and `runs/cf-measure-2026-09-03/` (untracked).

## 1. Verdict

**No measurable framework regression.** The framework's own cost on the turn path is
unchanged and negligible; every large difference between the trees is provider-side
variance that the interleaved runs show on both sides. The Workers/DO host runs the new
code, emits the unified `metrics` vocabulary live, and the dispatch-mode contract holds on
the deployed edge. Two pre-existing gaps surfaced and were filed.

## 2. What the framework itself costs (provider-free)

`bench-eos-to-delta.ts`: `eos.turn_complete` → first `llm.delta` through
`VoiceAgentSession` + `ReasoningBridge` with a reasoner that yields immediately, 40 turns,
two passes per tree, interleaved.

| tree | p50 | p90 | max (first-run JIT) |
| --- | --- | --- | --- |
| before | 0.29 / 0.33 ms | 0.47 / 0.61 ms | 11.8 / 11.5 ms |
| after | 0.28 / 0.33 ms | 0.75 / 0.65 ms | 11.6 / 11.6 ms |

`unattributedMs` — the session's own residual after subtracting the provider stages — read
**0 ms on every decomposed live turn, both trees** (16 turns).

## 3. Live Node turns (provider-bound, noisy)

`smoke:turn-latency` (one live turn per run) and the decomposition spike, interleaved
before/after so both trees see the same provider weather.

| arm | before ttfaMs median (n) | after ttfaMs median (n) |
| --- | --- | --- |
| native realtime | 673 (5), 471–998 | 502 (4), 484–521 |
| cascade, smoke | 4674 (3), 1623–8520 | 6976 (4), 1314–14059 |
| cascade, decomposed | 2284 (9), 1368–13753 | 7753 (7), 1892–15180 |

Cascade decomposition, medians: LLM first token 1504 ms before vs 5401 ms after; TTS first
byte 198 vs 286 ms; text aggregation 228 vs 223 ms. The LLM leg is the entire difference,
and the reasoner-only gate (`bench-reasoner-latency.ts`, direct `reasoner.stream` →
OpenAI, no session, identical code in both trees) swung across interleaved passes:

| pass | before gpt-4.1-mini TTFT P50 | after |
| --- | --- | --- |
| 1 | 828 ms | 895 ms |
| 2 | 872 ms | 7128 ms |
| 3 | 1850 ms | 907 ms |

OpenAI first-token latency varied by an order of magnitude within the hour on code that
did not change. Combined with section 2, the cascade gap is provider noise, not a
regression. Failures: 4 of 20 smoke runs ("fired without an anchor") and 4 of 20 spike runs
(Deepgram STT `WebSocket connect timeout` at init, 3 after / 1 before) hit both trees; the
STT connect path (`packages/ws`, `stt-core`, `deepgram/stt.ts`) has no diff between them.

Every decomposed cascade turn was `endpointingReason: "force_finalized"` (provider
endpointing did not fire on the fixture; the 7 s watchdog did) on both trees and on both
hosts. That is the pre-existing endpointing class the board already tracks, and it is why
there is still no trustworthy cascade voice-to-voice baseline.

## 4. Cloudflare Workers, deployed

Two throwaway Workers built from each tree (`syrinx-post-run-proof`,
`syrinx-post-run-proof-before`) plus the media-lane proof Worker; all three deleted
afterwards (`/health` → 404).

- **Session start** (`run-session-start-baseline.ts`, cascaded Worker, 5 reps): cold
  connect→ready 2693 ms, warm 1140 ms. August baseline was 1427 ms cold; one cold sample
  tonight, so noted, not concluded.
- **Wire contract** (`run-edge-metrics-probe.ts`): after tree emits `metrics` with
  `ttfaMs 2467, anchor "eos", llmTtftMs 1903, textAggregationMs 49, ttsTtfbMs 515,
  unattributedMs 0` plus marks and `eouBudgetMs`; before tree emits the old
  `llmTTFTMs 7204, ttsTTFBMs 718` shape. `turn_latency` is not forwarded on the edge in
  either tree — filed.
- **Media lane, lane proof as shipped** (serial parked handler, 3 repeats): after arm gaps
  81 / 74 / 9861 ms, before 9947 / 119 / 9993, control 179–366. Same as 18 August: a
  serial awaiting handler can still park audio on a Durable Object, which is exactly why
  the dispatch-mode contract now forbids registering one by accident.
- **Media lane, remedy proof** (park mode selected per session, `main` vs `concurrent`
  interleaved, 3 pairs): main 348 / 61 / 74 ms, concurrent 103 / 350 / 157 ms — no parks
  in either arm tonight; the earlier lane proof's 9861 ms was the one park seen.

## 5. Filed

- "Forward turn_latency on the Workers/DO edge wire so both hosts emit the same latency
  frames" (todo, auto).
- "Measure the two production serial handlers on workerd…" (scope, from the review).

## 6. What would change this verdict

A framework regression would show as `unattributedMs > 0` on live turns or a shift in
the provider-free microbench; neither moved. A provider-side shift would need a
same-minute, same-request A/B — the reasoner gate is that, and it moved with the clock,
not the tree.
