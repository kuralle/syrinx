# VE-05 Bridge — Latency Budget & Per-Stage Metrics

## Current state in Syrinx

Syrinx emits some useful turn metrics. `TurnMetricsTracker` records VAD speech end, STT final, first LLM delta, first TTS audio byte, first playout start, and playout completion (`packages/voice-server-websocket/src/turn-metrics.ts:91`). It computes `sttMs`, `llmTTFTMs`, `ttsTTFBMs`, and `e2eMs` (`packages/voice-server-websocket/src/turn-metrics.ts:43`). The session also emits VAQI latency when first TTS audio arrives after speech end (`packages/voice/src/voice-agent-session.ts:792`). Provider scripts collect live STT/LLM/TTS timings (`scripts/run-kernel-benchmark.ts:1`).

Checklist items already PARTIAL: first-byte/first-token metrics, canonical v2v, VAQI latency constituent. Missing: monotonic time source, cancellation flags, P95/P99 histograms, explicit budget configuration, endpointing vs transcription split, and provider/model/region tags.

## Gap (what's actually missing)

VE-05 should turn ad hoc event timestamps into a canonical latency contract. The headline metric must be `AgentStartedSpeaking - UserStoppedSpeaking`, with `UserStoppedSpeaking` corrected for VAD hangover when possible. Every provider stage should emit first-token/first-byte/acquire/retry/cancel timing with a monotonic clock and dimensions.

## Implementation approach

Touch:

- `packages/voice/src/packets.ts` for a structured `latency.stage`/`metric.histogram` event, or extend `ConversationMetricPacket`.
- `packages/voice-server-websocket/src/turn-metrics.ts` for canonical turn latency state.
- `packages/voice/src/voice-agent-session.ts` and `voice-agent-session-util.ts` for VAD/EOU/STT/TTS watchdog metrics.
- Provider adapters for stage start/end/cancel metrics.

Pseudocode:

```ts
interface LatencyStageMetric extends VoicePacket {
  readonly kind: "metric.latency_stage";
  readonly stage: "vad_stop" | "endpointing" | "stt_final" | "llm_ttft" | "tts_ttfb" | "playout_start";
  readonly durationMs: number;
  readonly cancelled: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly region?: string;
}

const now = () => performance.timeOrigin + performance.now();

function computeV2V(t: TurnLatencyState): number | null {
  if (!t.userStoppedRawMs || !t.agentStartedSpeakingMs) return null;
  return t.agentStartedSpeakingMs - t.userStoppedRawMs;
}
```

Provider adapters should emit request start and first-byte/token deltas, and mark attempts cancelled on `interrupt.*`. `TurnMetricsTracker` should continue sending browser JSON metrics, but the canonical metric backbone should be bus-native and exportable.

## Acceptance criteria (narrowed to the real gap)

- [ ] Latency metrics use a monotonic time source and include `cancelled`.
- [ ] Canonical v2v is computed from raw or corrected `UserStoppedSpeaking` to `AgentStartedSpeaking`.
- [ ] STT transcription delay and endpointing delay are separate fields.
- [ ] Metrics include provider, model, and region where known.
- [ ] A real 3+ turn run reports per-turn and aggregate P50/P95/P99 for v2v, STT final, LLM TTFT, TTS TTFB, and playout start.

## Risks & edge cases

`Date.now()` is currently embedded in packet timestamps; replacing it everywhere is invasive. Start by adding monotonic metrics alongside existing wall-clock packets. Provider region can be unknown; use explicit `"unknown"` tags rather than omitting dimensions. Cancelled attempts must not pollute latency histograms but should still count as cancellation/error metrics.

## WBS for ICs (§8)

| ID | Sub-task | Files | Acceptance | Depends on |
|---|---|---|---|---|
| VE-05.1 | Add latency metric packet/helper | `packages/voice/src/packets.ts`, `packet-factories.ts` | Monotonic metric helper tested | VE-01 |
| VE-05.2 | Refactor turn metrics to canonical fields | `packages/voice-server-websocket/src/turn-metrics.ts` | Browser metrics still work; new fields separate endpoint/STT | VE-05.1 |
| VE-05.3 | Instrument LLM/TTS/STT providers | `voice-bridge-aisdk`, `voice-stt-*`, `voice-tts-*` | First-byte/token metrics emitted with cancel flag | VE-05.1 |
| VE-05.4 | Aggregate percentiles in live script | extend `scripts/run-streaming-cascade.ts` / `run-full-cascade.ts` (no `run-tracer-bullet.ts` exists yet — net-new if added) | P50/P95/P99 printed and saved | VE-05.2 |
| VE-05.5 | Add budget config/docs | build docs / provider guide | Budget table exists and run fails or warns on threshold breach | VE-05.4 |
