# Phase 0 assumption spikes — implementation notes

Date: 2026-07-19. Purpose: falsify the assumptions behind the proposed "Phase 0 latency
instrumentation" work BEFORE building it. Every assumption below was stated by me from
reasoning, then attacked with either a runnable spike or retrieval against primary sources.

Artifacts:
- `examples/02-hello-voice-headless/scripts/spike-observability-decomposition.ts` (offline, A1)
- `examples/02-hello-voice-headless/scripts/spike-turn-decomposition-live.ts` (live, A2/A3/A6)
- `runs/spike-turn-decomposition.txt` (live output)

## Verdicts

| # | Assumption | Verdict |
|---|---|---|
| A1 | Existing observability can't decompose a turn | **FALSIFIED** |
| A2 | LLM + tool round-trips dominate the ~5.3s turn | **direction confirmed, mechanism falsified** |
| A3 | Tools explain the 0.9s vs 5.3s gap | **refined — indirect, not direct** |
| A5 | My four-probe metric set is the right one | **FALSIFIED in part** |
| A6 | Tool round-trips cost seconds | **FALSIFIED — tools cost 0ms** |

## A1 — the decomposition already ships

`voice-agent-session.ts:223` emits a `turn_latency` session event. Its own doc comment:

> Decomposition: eouDelayMs (speech end → endpoint) + llmTtftMs (endpoint → first LLM
> delta) + ttsTtfbMs (first TTS text dispatched → first audio).

Computed at `voice-agent-session.ts:946-955` from an existing `TurnTiming` struct
(`speechEndedMs`, `eosMs`, `firstLlmDeltaMs`, `firstTtsTextMs`). Additionally
`llm.tool_call` / `llm.tool_result` already exist as bus packets with matching `toolId`.

The offline spike separately proved that even the `ObservabilityObserver` histograms make
endpoint cost derivable (`v2v_ms − thinking_ms` = 1427ms vs 1400ms ground truth).

**Consequence:** the proposed Phase 0 item #1 (add four stage probes) is ~entirely
redundant. Three of four stages ship today.

## A2 / A6 — LLM dominates, but tools are free

Clean live run (n=1, cascade: Deepgram nova-3 → gpt-4.1-mini + tools → Cartesia sonic-3):

```
ttfaMs 3813ms
  llm        3412ms  90.4%
  tts_ttfb    217ms   5.7%
  tools         0ms   0.0%
  residual    184ms   4.9%
```

Independent attribution (own bus subscriptions) and the shipped `turn_latency` event agree
exactly on all three stages — a genuine cross-check, not one number reported twice.

`studentRelationsLookup` is `execute: async () => ({static object})`; there is **zero**
`fetch`/`await` anywhere in `university-support-agent.ts`. Tool execution measured 0–1ms
across runs. So `docs/interaction-thesis-results.md`'s "LLM + 2 tool round-trips =
2.6–4.3s (dominant)" is right that the leg dominates and **wrong about the mechanism**:
the cost is sequential LLM inference passes induced by `stopWhen: stepCountIs(3)`, not
tool work.

**Consequence:** a `tool_ms` probe would read ~0 on this benchmark. The discriminative
probe is **LLM call count + per-call TTFT**. (A production agent with real tool backends
would still want tool timing — the probe keeps production value, it just does not explain
this number.)

## A3 — tools explain the gap indirectly

`docs/latency-budget.md` reports ~618ms endpoint→first-token; this run shows 3412ms. The
difference is not tool execution. It is: multi-pass tool-calling inference vs a single
pass, no speculative-start in this path, and a much longer utterance/STT context. Tools
cause the gap by *inducing* extra inference passes, not by costing time themselves.

## A5 — the residual earned its place

Retrieval (LiveKit Agents source, Pipecat source, OTel GenAI semconv — note the OTel
GenAI spec **moved**; `opentelemetry.io/docs/specs/semconv/gen-ai/` is now a stub):

- Tool/LLM separation is standard: Pipecat `FunctionCallMetrics.duration_secs`, OTel
  `execute_tool` span. LiveKit has it in traces only, not `LLMMetrics`.
- I **missed** Pipecat's `TextAggregationMetricsData` (first LLM token → first complete
  sentence). I then wrongly asserted Syrinx has no such stage. It does:
  `bufferTtsText()` + `takeCompleteVoiceText()` + `ttsTextBuffers`.
- **No framework computes an unattributed residual.** Pipecat comes closest and never
  subtracts.

The residual measured 184ms (4.9%) and it is exactly `firstLlmDelta → firstTtsText` — the
sentence-aggregation tax the retrieval predicted and I denied. The residual found the
stage I got wrong. That is the argument for keeping it.

Summing traps to avoid (from the same retrieval): Pipecat's `TTFAMetricsData.ttfb`
duplicates the standalone TTFB metric; LiveKit's `STTMetrics.duration` is `0.0` for
streaming STT — the production config.

## Harness faults found and fixed (my bugs, not product bugs)

1. Offline spike emitted nothing — never called `bus.start()`; the bus only dispatches
   while its drain loop runs.
2. Live spike `finally` called `session.stop()`, which does not exist (`close()` does).
   The TypeError masked the real error from the try block.
3. Naive `await sleep(20)` per frame accumulated drift — a 30s fixture took 20s+ wall and
   let the endpointer fire mid-push, producing **negative** latencies. Replaced with
   pacing against an absolute schedule.
4. Continuing to push frames after EOS made the harness contend with the LLM stream for
   the event loop and inflated `llmTtftMs` (5036ms → 3412ms once fixed).

## Open / not established

- **n=1.** This is a direction, not a measurement. No percentiles, no repeat runs.
- Fixture `01-late-add` is **30s of audio**; EOS fires mid-file, so this is a long-utterance
  turn with a large STT context, not a short question. Not representative of the examiner's
  conversational turns.
- `eouDelayMs` came back `n/a` (never set) — unresolved whether that is a harness artifact
  (the spike pushes `user.audio_received` directly, possibly bypassing `vad.speech_ended`)
  or a real gap in the shipped event on this path. **Must be resolved before relying on it.**

## A7 — `turn_latency` structurally cannot measure the native realtime arm (NEW, verified)

Ran the same fixture, same tools, same instrument through the native front
(`SYRINX_SPIKE_ARM=native`: `fromOpenAIRealtime` + `RealtimeBridge` + delegated reasoner).

**Result: `turn_latency` never fired at all.**

Root cause, traced to the line:
- `timing.eosMs` is set in core's `eos.turn_complete` handler (`voice-agent-session.ts:1023-1024`),
  which is the FIRST thing to create the `TurnTiming` entry on a voice turn.
- `emitTurnLatency` is called from the first-`tts.audio` handler (`:1312`) and bails on
  `if (!timing) return` (`:938`).
- Measured native ordering: `firstTtsAudio` at +1075ms vs `eos` at +2699ms — **the assistant's
  first audio precedes `eos.turn_complete`**. So at `:1312` no `TurnTiming` exists yet and the
  event is silently dropped.

The instrument encodes a cascade-shaped ordering assumption (eos → LLM → audio). Native S2S
inverts it: the provider begins speaking before Syrinx's own endpointer fires. This is not a
missing field — the whole event is absent for the entire native arm.

`RealtimeBridge` also never populates `TurnTiming` (`speechEndedMs`/`firstLlmDeltaMs`/
`firstTtsTextMs` are never set there), so even fixing the ordering guard would yield a
`ttfaMs` with no stage breakdown.

**Consequence for the headline question ("TTFA for native vs cascade with tool calling"):
it is not answerable with the shipped instrument today.** Cascade measures; native does not.

The native run is ALSO invalid as a latency measurement for a second, independent reason:
with `server_vad` the front detected end-of-speech mid-fixture and answered a partial
utterance while frames were still being pushed (`firstLlmDelta` and `firstTtsText` land
*before* the speech-end anchor; `ask_university` shows NO RESULT PACKET). Both arms need a
short, single-question fixture before any cross-front number is trustworthy.

## A8 — PREAMBLE A/B: a prompt change cuts TTFA ~60% (VALIDATED, n=2 per arm)

The claim: the shipped system prompt's "Call studentRelationsLookup before answering" suppresses
pre-tool preamble text, and that suppressed text could have started TTS immediately.

Retrieval first established the mechanism is real: OpenAI's GPT-5 prompting guide documents
"tool preambles", and its worked example's output array is literally `reasoning` -> `message`
(output_text) -> `function_call` — text then tool call, one response. These stream as ordinary
content deltas ahead of the tool deltas, and the AI SDK surfaces them as `text-delta` parts.
So Syrinx's existing `llm.delta` -> `bufferTtsText` -> `tts.text` path would already speak a
preamble; nothing needed building.

Ran it live (`SYRINX_SPIKE_PROMPT=strict|preamble`, same fixture, same tools, same model):

| arm | ttfaMs | llmTtftMs | residual |
|---|---|---|---|
| A — shipped prompt | 3813, 4114 | 3412, 3539 | 184, 333 |
| B — preamble prompt | **1404, 1732** | 1161, 1270 | 18, 238 |

**~2400ms reduction, reproducible, non-overlapping ranges at n=2 per arm.**

Critically, this is NOT the filler trap. All three guards checked on every arm-B run:
- preamble emitted — *"Hi Maya. Let me check your late add request for the Biology 101 lab."*
- tool still called — `studentRelationsLookup`, 1 call
- grounded answer still delivered — same substance as arm A

Time-to-*answer* is unchanged. What changed is that 4.1s of silence became 1.4s to first
**truthful, informative** speech. Unlike a generic filler ("So,") or native realtime's misleading
"Are you still there?", the preamble is grounded in the actual request.

**Consequence for the plan:** this likely obviates the proposed "grounded tool-call cue" feature.
We were going to BUILD a mechanism to speak a grounded cue before a tool call; the model does it
for free when asked. Residual value for a cue layer is now only: tools that exceed a threshold
mid-call ("still working"), client-rendered UI (blocked on issue #30), and models that will not
emit preambles. Decide before building.

Caveats: n=2 per arm; one fixture; one model (gpt-4.1-mini); preambles are trained-in for
GPT-5-class models and may not appear on others regardless of prompt.

## A9 — speculative draft cost is UNMEASURABLE today

`ReasoningBridge.discardDraft()` / `runDraft()` emit no metric and no event. Draft churn is
invisible, so the cost of speculation cannot be measured on any endpointer. This matters because
`PipecatEOSPlugin.handleInterim` pushes `eos.interim` on EVERY non-empty interim, while Deepgram
Flux gates on `eager_eot_threshold` — and the repo's OQ2 "1 llm call, 0 resumed" result was
measured on Flux only. The zero-waste claim has never been checked on the smart-turn path, and
cannot be until counters exist. Filed as slice 1b.

## Corrections to earlier claims (validated by retrieval)

- **"stepCountIs(3) means a wasted 3rd pass"** — REFUTED. `stopWhen` is a cap, not a target; the
  loop's terminator is absence of a tool call, and `stopWhen` is only evaluated when the last step
  contains tool results. Raising the cap costs zero on the happy path. `stepCountIs(2)` is the
  riskier setting. (Also: AI SDK's default is `isStepCount(1)` — no multi-step at all.)
- **"speculative start is a free win here"** — PARTLY REFUTED, see A9.
- **"speculative tool prefetch is a used technique"** — real and published (arXiv 2605.13360,
  safe/unsafe tool partition with write-buffering, 1.3-2.2x speedup) but **no shipping voice
  framework does it**; LiveKit explicitly executes tools only after turn confirmation.

## A10 — the delegated fix passed 294 unit tests and STILL failed live

Slice 1 (delegated, issue #33) landed the ordering fix, the anchor discriminator, `speech_stopped`
propagation, the aggregation stage, the residual, LLM pass counts and speculative counters. All
independently re-verified green: core 294, realtime 69, aisdk 46, smart-turn 36, typechecks exit 0.

**The live native run still reported `(turn_latency never fired)`.**

Root cause: `RealtimeBridge.onResponseStarted` rotates `this.contextId = crypto.randomUUID()` when
the provider starts responding. So:

1. `speech_stopped` -> `vad.speech_ended` on context **A** -> `timingFor(A).speechEndedMs` set
2. `response_started` -> contextId rotates to **B**
3. `tts.audio` on context **B** -> `emitTurnLatency(B)` -> no record -> `anchorMs === undefined` -> return

The anchor is recorded under one context and looked up under another. Every existing
`turn_latency` test — including the three the worker added — used a **single** contextId, so none
of them could ever exercise the rotation. A green suite certified a feature that does not work.

Fix: `carryTurnTimingAcrossContextChange()` on the existing `turn.change` handler, migrating the
record from `previousContextId` to the new context and filling only gaps (anything already
recorded on the new context wins). Plus a regression test that actually rotates the context.

**The lesson worth keeping:** for this instrument, unit tests are structurally incapable of
catching identity/lifecycle bugs, because the test author chooses the contextId and will naturally
choose one. Only the live run varies it. Any future work on turn identity must be gated on a live
proof, not a suite.

## A11 — native FIXED (third attempt), breakdown still partial

Root cause, established by adapter-level tracing rather than guessing: **`speech_stopped` arrives
BEFORE `response_started`**, when `RealtimeBridge.contextId` is still empty, so
`onSpeechStopped`'s `if (!this.contextId) return` guard dropped it. Neither of the two earlier
diagnoses (ordering, contextId rotation) was the blocker — both were real but secondary.

Fix: buffer the pre-response speech-end timestamp and bind it to the response context on
`response_started`, then let the existing `turn.change` carry-forward merge later stages.

Live proof (native, OpenAI Realtime):

```
[+22795ms] vad.speech_ended   ctx=e7eedb27-...      <- now present; was absent entirely
[+22796ms] turn.change        ctx=e7eedb27-...
[+23581ms] tts.audio          ctx=e7eedb27-...
  ttfaMs         798ms   anchor=speech_end
  llmTtftMs      523ms
  unattributedMs 275ms
```

**Still partial.** `eouDelayMs`, `textAggregationMs`, `ttsTtfbMs` and `llmCallCount` are all `n/a`
on native:
- `eouDelayMs` — `eos.turn_complete` arrives at +25671ms, i.e. AFTER first audio (+23581ms), so
  `eosMs` is not yet set when `emitTurnLatency` runs.
- `textAggregationMs` / `ttsTtfbMs` — `llm.delta` and `tts.text` land on the `idle-*` context; the
  carry-forward did not bring `firstTtsTextMs` onto the response context. Needs investigation, not
  a guess.
- `llmCallCount` — the aisdk per-pass metrics are not wired on the delegate path.

The residual is doing exactly its job: it reports 275ms unexplained (798 − 523) rather than
silently implying the turn is fully attributed. That is the argument for keeping it.

**Three attempts to fix this, all with a green suite.** Attempts 1 and 2 passed 294/295 tests and
failed live. Only adapter-level tracing found it. The class-level lesson stands and is NOT yet
addressed structurally: the core test file still has ~203 hardcoded `contextId` literals against 1
test that rotates.

## A12 — speculative start is NET-HARMFUL on smart-turn (13 wasted calls, 0 promotions)

The counters shipped in slice 1b made this measurable for the first time. Live A/B, one turn each,
same fixture/model, cascade + smart-turn endpointer:

| | started | discarded | promoted | ttfaMs | llmTtftMs |
|---|---|---|---|---|---|
| speculative ON | 13 | **13** | **0** | 1724 | 1269 |
| speculative OFF | 0 | 0 | 0 | **1302** | **1025** |

**Thirteen speculative LLM calls, every one discarded, none promoted — and latency got worse.**

Mechanism (confirmed in source, not inferred): promotion requires
`draft.contextId === eos.contextId && draft.userText === eos.text` — **exact string equality**.
- Deepgram **Flux** gates its eager endpoint on `eager_eot_threshold` and *guarantees* the
  EndOfTurn transcript matches the preceding EagerEndOfTurn when no TurnResumed intervened. Drafts
  promote. This is the configuration the repo's OQ2 "1 llm call, eager endpoints 1, resumed 0"
  result was measured on, and it is correct there.
- **`PipecatEOSPlugin.handleInterim`** pushes `eos.interim` on EVERY non-empty STT interim. Each one
  calls `discardDraft()` and starts a fresh call. The surviving draft is built on an *interim*
  transcript, which rarely equals the final (punctuation, casing, late corrections) — so promotion
  is structurally near-impossible.

**This corrects a standing claim in the repo.** `docs/latency-budget.md` says Lever D
"is what actually gets under 1s". That is true *on Flux*. On a per-interim endpointer it is 13x the
LLM spend for negative latency benefit. The option is now documented accordingly at its definition
in `packages/aisdk/src/index.ts`.

Caveat: n=1 per arm; the 1724-vs-1302 latency delta is within provider noise and should not be
read as "speculation costs 400ms". The load-bearing numbers are **13 discarded / 0 promoted**,
which are structural, not noise.

## A13 — hedging: small median gain, overlapping ranges, tail untestable at n=3

`HedgedReasoner` composed on the cascade path (built for the reasoner-latency RFC, never wired
here). 3 paired live runs, `hedgeAfterMs: 600`, same fixture/model:

| run | ttfa OFF | ttfa ON | llmTtft OFF | llmTtft ON |
|---|---|---|---|---|
| 1 | 1502 | 1293 | 985 | 842 |
| 2 | 1337 | **1415** | 867 | **932** |
| 3 | 1484 | 1336 | 974 | 880 |
| median | 1484 | **1336** | 974 | **880** |

Median ttfa improves ~148 ms and median llmTtft ~94 ms. **But the ranges overlap** — run 2 was
*slower* with hedging, and OFF's best (1337) beats ON's worst (1415). At n=3 this is a direction,
not a result.

More important: **this does not test what hedging was built for.** The RFC's claim is tail
reduction (−59% on worst-of-9), and a 3-run sample has no tail visibility whatsoever. The median is
the thing hedging is *least* expected to move; measuring it here and finding a small overlapping
gain is consistent with both "hedging works as designed" and "this is noise".

Cost is real and certain: hedging runs a second inference per hedged turn. Recommending it on the
strength of a median gain measured at n=3 would be spending 2x LLM budget on a number that has not
been established.

**Verdict: not adopted by default. Re-measure with a tail-shaped design** (n>=20, report P50/P95,
ideally a fixture mix with known slow cases) before composing it into a shipped agent. The wiring
is now in place (`hedgeAfterMs` on the example session + `SYRINX_SPIKE_HEDGE_MS` on the harness),
so that run is cheap to do.

## What Phase 0 actually is, after this

Not "add stage instrumentation." That exists. The real work:

1. Bridge `turn_latency` → `MetricsExporter` (today it is a session event; exporter
   defaults to noop, so nothing leaves the process). This is the substantive gap.
2. Add the aggregation stage (`firstLlmDelta → firstTtsText`) and an explicit residual.
3. Add **LLM call count + per-call TTFT** (not `tool_ms`) to attribute multi-pass turns.
4. Resolve the `eouDelayMs` n/a.
5. Fix `docs/interaction-thesis-results.md`'s tool-round-trip attribution — it is wrong
   about mechanism and will mislead anyone optimising from it.
