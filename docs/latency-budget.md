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
- Per-stage timings: `TurnMetricsTracker` (`packages/voice-server-websocket/src/turn-metrics.ts`) + the interactive smoke harness + the `obs.turn_boundary` histograms (VE-07.3).
- EOU sub-budget (VAD stop hangover + STT-final delay + endpoint delay + sum): `eouBudgetMs` (VE-02.3).
- Monotonic time source + `cancelled` flag: `observability.ts` `monotonicNowMs` + `ObservabilityObserver` (VE-07), so cancelled attempts never pollute the latency histograms and metrics are exporter-agnostic.
