# VE-09 Bridge — Greenfield Gaps

## Current state in Syrinx

Greenfield items are mostly absent by definition. Syrinx has enough telemetry primitives to seed future work: provider timing scripts (`scripts/run-streaming-cascade.ts:1`), per-turn metrics (`packages/voice-server-websocket/src/turn-metrics.ts:43`), VAQI constituents (`packages/voice/src/voice-agent-session-util.ts:113`), and in-process VAD (`packages/voice-vad-silero/src/index.ts:35`). It does not implement dynamic hedging, bandit routing, supervised VAD subprocesses, pre-TTS guardrails, VAQI rollup, full replay/load/fault injection, dynamic multilingual TTS switching, µ-law passthrough, or S2S audit shadow transcription.

## Gap (what's actually missing)

VE-09 should not be implemented as one monolith. It is a design-first backlog of net-new systems that depend on VE-05/VE-07 telemetry. Each item needs a child RFC with metrics, failure modes, rollout controls, and cost guards.

## Implementation approach

Child RFCs:

1. Dynamic hedging and bandit routing over provider endpoints.
2. Supervised VAD subprocess with auto-respawn.
3. Pre-TTS guardrail/classifier on the critical path.
4. VAQI rollup **formula + tolerance bands** only — the missed-response window already exists (`vaqiMissedResponseMs` default 4000 ms, `voice-agent-session-util.ts:70,113`) and all three constituents already emit (`vaqi.interruption`, `vaqi.latency_ms`, `vaqi.missed_response`); this RFC *consumes* them into a single I/M/L score, it does NOT re-spec the window or constituents.
5. Replay/load/fault-injection harness.
6. Dynamic multilingual voice switching.
7. µ-law passthrough benchmark/path.
8. S2S audit shadow transcription.

Hedging pseudocode:

```ts
interface EndpointHealth {
  readonly endpointId: string;
  meanMs: number;
  sigmaMs: number;
  p95Ms: number;
  available: boolean;
}

function hedgeTimeout(health: EndpointHealth, k: number): number {
  return Math.min(maxTimeoutMs, Math.max(minTimeoutMs, health.meanMs + k * health.sigmaMs));
}

async function callWithHedge(req: ProviderRequest): Promise<ProviderResponse> {
  const primary = router.choosePrimary(req);
  const timeout = hedgeTimeout(histograms.get(primary.id), k);
  const primaryCtl = new AbortController();
  const primaryPromise = primary.call(req, primaryCtl.signal);
  const hedgePromise = sleep(timeout).then(() => router.nextFastest(req).call(req, AbortSignal.timeout(maxTimeoutMs)));
  const winner = await Promise.race([primaryPromise, hedgePromise]);
  primaryCtl.abort();
  return winner;
}
```

Pre-TTS guardrail pseudocode:

```ts
bus.on("tts.text", async (pkt) => {
  const start = now();
  const verdict = await classifier.classify(pkt.text, { contextId: pkt.contextId });
  emitLatency("guardrail.pre_tts", now() - start);
  if (verdict.allow) {
    bus.push(Route.Main, make.ttsTextApproved(pkt.contextId, pkt.timestampMs, pkt.text));
  } else {
    bus.push(Route.Main, make.injectMessage(pkt.contextId, Date.now(), verdict.replacementText));
  }
});
```

Replay harness pseudocode:

```ts
interface ReplayScenario {
  readonly inputWav: string;
  readonly networkProfile: "clean" | "jittery" | "lossy";
  readonly providerFaults: readonly ProviderFault[];
  readonly assertions: { readonly p95V2vMs: number; readonly maxSilentMs: number };
}

async function runReplay(scenario: ReplayScenario): Promise<ReplayReport> {
  const packets = await injectRecordedAudio(scenario.inputWav, scenario.networkProfile);
  applyFaults(scenario.providerFaults);
  return assertDistributions(packets, scenario.assertions);
}
```

## Acceptance criteria (narrowed to the real gap)

- [ ] Each greenfield item has an approved child RFC before code changes.
- [ ] Hedging/bandit RFC depends on VE-05/VE-07 histograms and includes exploration/cost guards.
- [ ] VAD subprocess RFC defines IPC packet format, restart behavior, and failure fallback.
- [ ] Pre-TTS guardrail RFC includes P95 budget and replacement/escalation behavior.
- [ ] VAQI RFC defines I/M/L formula, tolerance bands, and missed-response window.
- [ ] Replay harness RFC defines recorded-audio fixtures, provider fault injection, and P95/P99 assertions.
- [ ] µ-law passthrough RFC benchmarks native provider support before changing pipeline defaults.

## Risks & edge cases

Hedging can double provider cost and race duplicate side effects if applied beyond pure STT/TTS/LLM calls. Bandit routing can chase noise without enough samples. VAD subprocess IPC can add latency and serialization overhead. Guardrails before TTS are safety-critical but can harm TTFA; budget them as first-class stages. VAQI can become meaningless if constituents are not normalized by context and deployment.

## WBS for ICs (§8)

| ID | Sub-task | Files | Acceptance | Depends on |
|---|---|---|---|---|
| VE-09.1 | Hedging/bandit child RFC | `knowledge-research/build/reconcile/children/` | RFC maps histograms to routing and cost guard | VE-05/VE-07 |
| VE-09.2 | VAD subprocess child RFC | same | RFC defines IPC, restart, degraded fallback | VE-02/VE-06 |
| VE-09.3 | Pre-TTS guardrail child RFC | same | RFC defines classifier API and P95 budget | VE-05/VE-07 |
| VE-09.4 | VAQI rollup child RFC | same | Formula and missed-response window approved | VE-07 |
| VE-09.5 | Replay/load/fault harness child RFC | same | Scenario format and P95/P99 assertions approved | VE-05/VE-07 |
| VE-09.6 | Dynamic multilingual switching child RFC | same | Voice map/warm switch/gap behavior specified | VE-08 |
| VE-09.7 | µ-law passthrough child RFC | same | Benchmark matrix for STT/TTS native µ-law support | VE-04/VE-05 |
| VE-09.8 | S2S audit shadow transcript child RFC | same | Audit path and storage/cost/privacy rules specified | VE-07 |
