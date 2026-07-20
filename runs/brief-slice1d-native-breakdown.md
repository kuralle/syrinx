# Brief — SLICE 1d: complete the native stage breakdown (issue #33 remainder)

You are operating in **autonomous delivery mode**: decompose, drive to zero, verify with real exit
codes, ship. Do not pause for permission. Scope is exactly the four fields below.

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`.

**Command efficiency rule (inherit this):** NEVER re-run an expensive or slow command just to change
a pipe/filter. Run it ONCE, capture FULL output to a unique temp file via
`log=$(mktemp); cmd > "$log" 2>&1`, then grep `"$log"` repeatedly.

## Status — read this so you do not redo finished work

`turn_latency` now fires on BOTH fronts. Cascade is **fully attributed**:

```
ttfaMs 1685  anchor=eos   llmTtftMs 1241  textAggregationMs 233  ttsTtfbMs 211
unattributedMs 0          llmCallCount 1  passTtft=[1238]
```

Native fires but reports only three fields:

```
ttfaMs 798   anchor=speech_end   llmTtftMs 523   unattributedMs 275
eouDelayMs n/a   textAggregationMs n/a   ttsTtfbMs n/a   llmCallCount n/a
```

Your job is the four `n/a`s on native, plus one anomaly on cascade.

Reproduce both:
```
cd examples/02-hello-voice-headless
SYRINX_SPIKE_TRACE=1 SYRINX_SPIKE_ARM=native  npx tsx scripts/spike-turn-decomposition-live.ts
SYRINX_SPIKE_TRACE=1 SYRINX_SPIKE_ARM=cascade npx tsx scripts/spike-turn-decomposition-live.ts
```

## The five items, each with its own cause — diagnose before fixing

**1. `textAggregationMs` and `ttsTtfbMs` are n/a on native.** The trace shows `llm.delta` and
`tts.text` landing on an `idle-*` contextId while `tts.audio` lands on the response UUID:

```
[+16893ms] llm.delta    ctx=idle-1784479123001
[+16915ms] tts.text     ctx=idle-1784479123001
[+22795ms] vad.speech_ended  ctx=e7eedb27-...
[+22796ms] turn.change       ctx=e7eedb27-...  prev=idle-...
[+23581ms] tts.audio         ctx=e7eedb27-...
```

`VoiceAgentSession.carryTurnTimingAcrossContextChange` is supposed to merge the previous context's
record forward on `turn.change`. Establish **why `firstTtsTextMs` did not survive the merge** — note
those deltas are from the PRIOR turn (they precede this turn's speech-end), so the honest answer may
be that there is no aggregation stage for this turn at all, in which case `n/a` is correct and the
fix is to say so rather than to fabricate a number. Decide with evidence from the trace.

**2. `eouDelayMs` is n/a on native.** `eos.turn_complete` arrives at +25671ms, AFTER first audio at
+23581ms, so `eosMs` is unset when `emitTurnLatency` runs. Decide and implement one of:
(a) native legitimately has no endpoint-delay stage — the front owns turn-taking, Syrinx's endpointer
does not run — so `n/a` is the correct, documented answer; or (b) it should be emitted late.
**Prefer (a) if the evidence supports it** and document it on the event's doc comment. Do not invent
a stage that does not exist on that front.

**3. `llmCallCount` is n/a on native.** The aisdk per-pass metrics are emitted by `ReasoningBridge`;
the native path runs the reasoner through `RealtimeBridge`'s delegate instead. Wire the same
`llm.call_started` / `llm.pass_ttft_ms` conversation metrics on the delegate path.

**4. ANOMALY — cascade reports `llmCallCount 1` on a turn that called a tool.** A tool-calling turn
needs at least two provider round-trips (the model cannot answer before the tool returns), so 1 is
almost certainly an under-count: likely only the first pass is counted, or the counter resets
per-pass. Find the truth and fix it. `passTtft=[1238]` having exactly one entry is the same symptom.
This one is load-bearing — the whole point of the field is distinguishing "3 passes at 1.1s" from
"1 slow pass", and it is currently lying.

**5. Guard the residual.** After your fixes, native's `unattributedMs` should shrink toward 0 the way
cascade's did. If it does not, that is a finding — report the remaining gap rather than clamping the
field.

## The test-coverage trap — this is not optional

Every `turn_latency` unit test except one hardcodes a **single** contextId (~203 literals in
`packages/core/src/voice-agent-session.test.ts`). The bugs in this area are all about identity
changing mid-turn, so the suite is structurally blind to them: three consecutive fix attempts here
passed 294/295 tests and failed live.

Model your tests on `it("emits turn_latency when the realtime front rotates contextId mid-turn")` in
that file. **A green suite is not acceptance.** The acceptance criterion is the live run.

## Definition of done

- Live native run prints a breakdown where every field is either a real number or a **documented,
  justified** `n/a` — paste the output in your report.
- Live cascade run still fully attributed (`unattributedMs 0`) and now reports a truthful
  `llmCallCount` for a tool-calling turn — paste that too.
- `pnpm --filter @kuralle-syrinx/{core,realtime,aisdk} test` and their typechecks: exit 0.
- Report per item (1-5): what you found, what you changed, or why `n/a` is correct.

## Hard rules

- No `--no-verify`, no `@ts-ignore`, no swallowed errors, no skipped tests.
- **If a fix does not change the live output, STOP and re-triage.** Do not layer a second patch on a
  failed first — that is how the parent bug survived two attempts.
- Do not fabricate a stage to make the residual look better. `n/a` with a reason beats a wrong number.
- OpenAI Realtime and Deepgram/Cartesia work live here. Gemini keys do NOT.
