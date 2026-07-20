# Brief — SLICE 1 + 1b: turn-latency instrument (GitHub issue #33)

You are operating in **autonomous delivery mode**. Decompose the goal into ordered verifiable
moves, drive them to zero, verify with real command exit codes, and ship finished work without
pausing for permission. Do not stop early for time or complexity. Do not gold-plate — scope is
exactly what is written here.

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx` (pnpm monorepo, TypeScript).
Read GitHub issue #33 (`gh issue view 33 --repo kuralle/syrinx`) — it is the spec, with a TDD plan.

**Command efficiency rule (inherit this):** NEVER re-run an expensive or slow command just to
change a pipe/filter. Run it ONCE, capture FULL output to a unique temp file via
`log=$(mktemp); cmd > "$log" 2>&1`, then grep `"$log"` as many times as needed.

## Context — what was measured, so you know what you are fixing

A live spike decomposed one cascade turn: `ttfaMs 4114ms` = `llmTtft 3539` + `ttsTtfb 242` +
an unexplained `333ms` residual. The same spike on the **native realtime** front produced
**nothing at all** — `turn_latency` never fired. That is the bug.

## Defect 1 — ordering assumption drops every native turn

- `VoiceAgentSession.emitTurnLatency` (`packages/core/src/voice-agent-session.ts:935`) is called
  from the first-`tts.audio` handler (`:1312`) and bails at `if (!timing) return` (`:938`).
- The `TurnTiming` record is first created in the `eos.turn_complete` handler (`:1023-1024`).
- Cascade ordering is eos → llm → audio, so the record always exists. **Native S2S inverts it**:
  measured `firstTtsAudio +1075ms` vs `eos +2699ms` — audio arrives 1.6s BEFORE eos, so no record
  exists and the turn is silently dropped.

**Fix:** create the record on demand (there is already a `timingFor(contextId)` helper at `:926`)
instead of bailing. Preserve the existing guard that non-voice/text-injected turns emit nothing
(the `anchorMs === undefined` check at `:939-940`) and that barge-in turns are not double-counted.

## Defect 2 — silent anchor fallback makes `ttfaMs` two different metrics

`:939` reads `const anchorMs = timing.speechEndedMs ?? timing.eosMs;` and nothing in the payload
records which was used. Add an explicit discriminator to the `turn_latency` payload
(`:214` region, the `VoiceSessionEvents` interface — the event is declared around `:223-232`):

    anchor: "speech_end" | "eos"

Populate it at emit time. This is load-bearing: without it a dashboard silently compares
speech-end-anchored cascade numbers against eos-anchored native numbers.

## Defect 3 — the adapter drops the provider's end-of-user-speech signal

- `RealtimeEvent` (`packages/realtime/src/realtime-adapter.ts:68-77`) models `speech_started`
  but has **no** speech-stopped variant.
- `packages/realtime/src/openai-compatible-realtime.ts:311` handles
  `input_audio_buffer.speech_started`. OpenAI also sends `input_audio_buffer.speech_stopped`
  and it is discarded.
- Consequently `RealtimeBridge` never pushes `vad.speech_ended`, so `speechEndedMs`
  (set only at `voice-agent-session.ts:922`) is never set on the native path.

**Fix:** add `{ type: "speech_stopped" }` to the union; emit it from the OpenAI-compatible
adapter; have `RealtimeBridge` (`packages/realtime/src/realtime-bridge.ts`, alongside the
`speech_started` case at `:227`) push a `vad.speech_ended` packet. Gemini has no direct
equivalent — leave `from-gemini-live.ts` alone (separate issues #28/#32 cover it).

## Defect 4 — the bridge contributes no stage timings

`RealtimeBridge` never populates `TurnTiming` at all (no `firstLlmDeltaMs`, no `firstTtsTextMs`).
Even with the ordering fixed, native would report a total with no breakdown. Ensure the bridge's
generation path produces the same `llm.delta` / `tts.text` bus signals the session already keys
off, so the existing handlers populate the record. Prefer reusing existing handlers over adding
a parallel timing path.

## Addition 1 — the aggregation stage (this is a real, measured stage)

The `333ms` residual is exactly `firstLlmDelta → firstTtsText` — the sentence-aggregation tax in
`bufferTtsText()` / `takeCompleteVoiceText()` (`voice-agent-session.ts:1110-1122`). Pipecat calls
this `TextAggregationMetricsData`; match that concept. Add to the payload:

    textAggregationMs?: number    // firstTtsTextMs - firstLlmDeltaMs

## Addition 2 — the explicit residual

Add `unattributedMs` = `ttfaMs - (eouDelayMs + llmTtftMs + textAggregationMs + ttsTtfbMs)`,
counting only the terms actually present. **No framework computes this** (verified against
LiveKit, Pipecat, OTel GenAI semconv) — it is how we detect that the stage model has drifted
from reality. It is allowed to be negative if stages overlap; report it, do not clamp it.

## Addition 3 — LLM pass count

`llmTtftMs` collapses N sequential inference passes into one number. Under
`stopWhen: stepCountIs(3)` a 3539ms reading could be 3 passes or 1 slow pass — different
problems. Add `llmCallCount` and per-pass TTFT to the payload. Source the signal in
`packages/aisdk/src/index.ts` (`ReasoningBridge`) where the AI SDK stream is consumed.
Do **NOT** add a `tool_ms` probe — tool execution measured 0ms here (the fixture's tools are
local stubs); `llm.tool_call`/`llm.tool_result` already exist on the bus if anyone wants it later.

## Addition 4 (slice 1b) — speculative draft lifecycle is invisible

`ReasoningBridge.discardDraft()` / `runDraft()` (`packages/aisdk/src/index.ts`, around `:236-262`)
emit no metric and no event, so the cost of speculation cannot be measured on any endpointer.
This matters: `PipecatEOSPlugin.handleInterim` (`packages/pipecat-smart-turn/src/eos-plugin.ts:168-180`)
pushes `eos.interim` on **every** non-empty interim, whereas Deepgram Flux gates on
`eager_eot_threshold`. Each interim calls `discardDraft()` then starts a new draft.

Add counters — `speculative.draft_started`, `speculative.draft_discarded`, `speculative.draft_promoted`
— via the existing `make.metric(...)` Background-route pattern used elsewhere in the codebase.
Do not change speculation behavior; only make it observable.

## Definition of done

- Every change is test-driven per issue #33's plan: write the failing test first, then the code.
- `pnpm --filter @kuralle-syrinx/core test` and `--filter @kuralle-syrinx/realtime test` and
  `--filter @kuralle-syrinx/aisdk test` all green, plus `pnpm -r typecheck` green.
- Regression tests exist for: audio-before-eos ordering; the anchor discriminator; a native turn
  producing a non-empty breakdown; non-voice turns still emitting nothing; barge-in not double-counted.
- Report at diff level: files changed, what each test pins, and the exact commands you ran with
  their exit codes. If you could not verify something, say so explicitly — do not claim done
  without proof.

## Hard rules

- No `--no-verify`, no `@ts-ignore`, no `try/catch` swallowing, no skipped tests. Fix root causes.
- Do not refactor adjacent code that is not broken. Match surrounding style.
- If a change balloons past this scope, stop and report why rather than expanding it.
