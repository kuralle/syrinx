# Brief — SLICE 2: export `turn_latency` through `MetricsExporter`

You are operating in **autonomous delivery mode**: decompose, drive to zero, verify with real exit
codes, ship. Do not pause for permission. Scope is exactly what is written here.

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`.

**Command efficiency rule (inherit this):** NEVER re-run an expensive or slow command just to change
a pipe/filter. Run it ONCE, capture FULL output to a unique temp file via
`log=$(mktemp); cmd > "$log" 2>&1`, then grep `"$log"` repeatedly.

## The problem

`VoiceAgentSession` emits a `turn_latency` **session event** carrying the full per-turn latency
decomposition — `ttfaMs`, `anchor`, `eouDelayMs`, `llmTtftMs`, `textAggregationMs`, `ttsTtfbMs`,
`unattributedMs`, `llmCallCount`, `llmPassTtftMs`, `fillerUsed`, `backchannelUsed`.

Separately, `MetricsExporter` (`packages/core/src/observability.ts`) is the export seam, and
`ObservabilityObserver` already pushes three coarse histograms through it (`v2v_ms`, `thinking_ms`,
`agent_speech_ms`).

**The two never meet.** The finest-grained data in the product is emitted as an in-process event
that nothing exports, and the default exporter is `noopMetricsExporter`, so a deployed session
produces no external latency signal at all. That is the gap: you cannot answer "is it healthy right
now?" without attaching a debugger.

## What to build

Emit each present `turn_latency` field as a histogram through the session's `MetricsExporter`,
alongside the existing `this.emit("turn_latency", ...)`. The values are already computed in
`emitTurnLatency` — this is a wiring change, not a measurement change.

Suggested names (mirror the event fields; keep them stable and greppable):
`turn.ttfa_ms`, `turn.eou_delay_ms`, `turn.llm_ttft_ms`, `turn.text_aggregation_ms`,
`turn.tts_ttfb_ms`, `turn.unattributed_ms`.

Omit a histogram when its field is absent — do not emit 0 for "not applicable". A missing
`eouDelayMs` on the native front means that stage does not exist there; recording 0 would corrupt
any average.

## Cardinality — this is the part to get right, and it is already decided by prior art

Verified against LiveKit Agents source, Pipecat source, and the OpenTelemetry GenAI semantic
conventions:

- **LiveKit restricts turn histograms to `{model_name, model_provider}`** (+ a `connection_reused`
  bool). High-cardinality ids — `room_id`, `job_id`, `speech_id` — live on **spans and the OTLP
  resource, never as metric dimensions.**
- **OTel semconv is explicit**: low-cardinality attributes only, and "if there is no low-cardinality
  workflow name available for a given framework, this attribute MUST NOT be captured by default."

So: allowed histogram tags are `provider`, `model`, `region`, `cancelled`, plus `anchor`
(`"speech_end" | "eos"` — two values, and it is load-bearing: it says which clock `ttfa_ms` was
measured from) and the boolean-ish `filler_used` / `backchannel_used` (a turn where a preamble or
filler spoke first is measuring time-to-acknowledgement, not latency — segregating on this is the
whole guard against re-creating the confound that made native realtime's "1.3s" meaningless).

**`sessionId` and `speechId` must NOT be histogram dimensions.**

**There is an existing violation to fix in the same pass:** `ObservabilityObserver.emitBoundary`
currently tags `v2v_ms` / `thinking_ms` / `agent_speech_ms` with `sessionId` **and** `speechId`.
That is unbounded cardinality on the only histograms the product currently exports. Remove them from
the metric tags; they stay on the `obs.turn_boundary` event, which is where per-turn identity
belongs.

## Constraints

- **Never block the turn.** `observeHistogram` on the noop exporter is free; a real exporter must
  buffer, never await. Do not introduce an `await` on the emit path.
- **Additive only.** The `turn_latency` event keeps firing exactly as it does now; existing
  consumers are unaffected.
- Do not build an OTLP or Analytics Engine exporter in this slice — the seam plus a correct
  in-memory implementation is the deliverable. `InMemoryMetricsExporter` already exists and is what
  your tests should assert against.

## Definition of done

- A cascade turn produces histograms for every present stage, asserted via
  `InMemoryMetricsExporter` in a unit test.
- A test pins the cardinality contract: **no histogram carries `sessionId` or `speechId`**, on the
  new turn metrics *and* on the three existing observer histograms.
- A test pins that an absent stage emits no histogram (rather than 0).
- `pnpm --filter @kuralle-syrinx/core test` and typecheck: exit 0. Full `pnpm -r test`: exit 0.
- Live sanity: `cd examples/02-hello-voice-headless && npx tsx scripts/spike-turn-decomposition-live.ts`
  still reports its decomposition unchanged (you have not altered measurement, only export).

## Hard rules

- No `--no-verify`, no `@ts-ignore`, no swallowed errors, no skipped tests.
- Do not refactor adjacent observability code that is not broken.
- Never claim verified what you did not verify.
