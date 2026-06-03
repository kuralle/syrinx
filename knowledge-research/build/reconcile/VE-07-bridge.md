# VE-07 Bridge — Observability & SLOs

## Current state in Syrinx

Syrinx has raw observability primitives: `PipelineBus.allPackets` and `onPacket` hooks (`packages/voice/src/pipeline-bus.ts:59`, `packages/voice/src/voice-agent-session.ts:224`), a debug conversation event stream (`packages/voice/src/voice-agent-session.ts:219`), browser metrics messages (`packages/voice-server-websocket/src/turn-metrics.ts:23`), and VAQI constituent metrics for interruption/latency/missed response (`packages/voice/src/turn-arbiter.ts:178`, `packages/voice/src/voice-agent-session.ts:797`, `packages/voice/src/voice-agent-session-util.ts:125`). Provider testing docs name live smoke artifacts (`PROVIDER-TESTING.md:1`).

Checklist items already PARTIAL: canonical event stream, v2v, transcription delay, VAQI constituents, replay/load scripts. Missing: Prometheus/OTel export, tagged histograms/traces, SLO definitions/alerts, synthetic probes/RUM.

## Gap (what's actually missing)

VE-07 should create one canonical observability backbone rather than adding more ad hoc `metric.conversation` strings. It must produce typed turn-boundary events, stage histograms, trace spans, dimensions, SLO dashboards/alerts, and incident drill-down by session id.

## Implementation approach

Touch:

- `packages/voice/src/conversation-event.ts`, `packets.ts`, and `packet-factories.ts` for canonical event types.
- `packages/voice/src/pipeline-bus.ts` or a new observer plugin for metric export.
- Provider adapters and transport host for provider/model/region/session/request tags.
- Build docs for SLO thresholds.

Pseudocode:

```ts
type TurnBoundaryKind =
  | "UserStartedSpeaking"
  | "UserStoppedSpeaking"
  | "AgentThinking"
  | "AgentStartedSpeaking"
  | "AgentAudioDone"
  | "Interruption";

interface TurnBoundaryEvent extends VoicePacket {
  readonly kind: "obs.turn_boundary";
  readonly boundary: TurnBoundaryKind;
  readonly sessionId: string;
  readonly speechId: string;
  readonly requestId?: string;
  readonly monotonicMs: number;
}

interface MetricsExporter {
  observeHistogram(name: string, valueMs: number, tags: Record<string, string>): void;
  startSpan(name: string, tags: Record<string, string>): SpanHandle;
}
```

Bridge `metric.conversation` into the new typed metric only temporarily; new code should publish typed events. Use VE-05 latency metrics as the source for P95/P99 SLOs.

## Acceptance criteria (narrowed to the real gap)

- [ ] Canonical turn-boundary packets exist for user start/stop, agent thinking, agent started, agent done, interruption, and tool lifecycle where relevant.
- [ ] Metrics exporter produces histograms tagged by session-id, speech-id, request-id, provider, model, region, and cancelled flag.
- [ ] OTel spans represent conversation -> turn -> STT/LLM/TTS/transport stages.
- [ ] SLO definitions exist for P95/P99 v2v, interruption success, and speech-path error rate.
- [ ] Given one session id, a developer can reconstruct the turn across logs/metrics/traces.

## Risks & edge cases

Adding export dependencies directly to core can bloat browser bundles. Keep exporter interfaces in `@asyncdot/voice` and implementation packages optional. High-cardinality tags like raw context ids must be used carefully in Prometheus; traces can carry full ids while metrics may need sampled/session-hashed labels.

## WBS for ICs (§8)

| ID | Sub-task | Files | Acceptance | Depends on |
|---|---|---|---|---|
| VE-07.1 | Define canonical observability event schema | `packages/voice/src/packets.ts`, `conversation-event.ts` | Types exported and covered by unit tests | VE-05 |
| VE-07.2 | Build metrics exporter interface | new `packages/voice/src/observability.ts` | No provider dependency in core; test exporter records histograms | VE-07.1 |
| VE-07.3 | Instrument stage spans/tags | provider adapters, session, transport | Events include provider/model/region/session/speech ids | VE-07.2 |
| VE-07.4 | Add SLO docs/dashboards | build docs / scripts | P95/P99 v2v and interruption success SLOs documented | VE-05 |
| VE-07.5 | Add incident reconstruction smoke | scripts/tests | One session id prints ordered boundaries and stage timings | VE-07.3 |
