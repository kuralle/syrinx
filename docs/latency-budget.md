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

## Where the numbers come from
- Per-stage timings: `TurnMetricsTracker` (`packages/voice-server-websocket/src/turn-metrics.ts`) + the interactive smoke harness.
- EOU sub-budget (VAD stop hangover + STT-final delay + endpoint delay + sum): `eouBudgetMs` (VE-02.3).
- Carried to VE-07 (observability): monotonic time source + `cancelled` flag + per-provider stage instrumentation, so cancelled attempts never pollute these histograms and metrics are exportable.
