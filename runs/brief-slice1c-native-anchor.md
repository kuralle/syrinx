# Brief — SLICE 1c: make `turn_latency` fire on the native realtime front (issue #33, remainder)

You are operating in **autonomous delivery mode**: decompose, drive to zero, verify, ship. Do not
pause for permission. Scope is exactly this — do not gold-plate.

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`.
Read `gh issue view 33 --repo kuralle/syrinx` **including the comments** — the second comment
contains the live trace that is the real spec. (If the GitHub API is unreachable, this brief is
self-contained; say so in your report.)

**Command efficiency rule (inherit this):** NEVER re-run an expensive or slow command just to
change a pipe/filter. Run it ONCE, capture FULL output to a unique temp file via
`log=$(mktemp); cmd > "$log" 2>&1`, then grep `"$log"` repeatedly.

## Status: cascade is DONE. Native is NOT. Do not re-do the cascade work.

Already landed and verified: ordering fix, `anchor` discriminator, `textAggregationMs`,
`unattributedMs`, `llmCallCount`/`llmPassTtftMs`, speculative draft counters, `speech_stopped`
added to `RealtimeEvent` + emitted by the OpenAI-compatible adapter + handled in `RealtimeBridge`,
and a `turn.change` carry-forward of `TurnTiming`. Cascade is live-proven:
`ttfaMs 4114 = llmTtft 3539 + ttsTtfb 242 + unattributed 333`.

**`turn_latency` still never fires on native.** That is the whole job.

## The evidence — a live native turn, ordered, with contextIds

```
[+15941ms] llm.delta          ctx=idle-1784472678604
[+15958ms] tts.text           ctx=idle-1784472678604
[+21770ms] turn.change        ctx=ebcd76e5-...   prev=idle-1784472678604
[+22756ms] tts.audio          ctx=ebcd76e5-...
[+24548ms] eos.turn_complete  ctx=ebcd76e5-...
[+24551ms] tts.end            ctx=ebcd76e5-...
```

Reproduce with:
`cd examples/02-hello-voice-headless && SYRINX_SPIKE_TRACE=1 SYRINX_SPIKE_ARM=native npx tsx scripts/spike-turn-decomposition-live.ts`

## Three problems, in priority order

**1. No user-side speech-end signal reaches the session (the blocker).**
Neither `vad.speech_started` nor `vad.speech_ended` appears anywhere in the trace.
`RealtimeBridge.onSpeechStarted` pushes `interrupt.detected` — **not** a VAD packet — and is gated
on `adapter.caps.emitsServerSpeechStarted`. The `speech_stopped -> vad.speech_ended` handler added
for this issue produces nothing in practice.

**Diagnose before fixing.** Determine which of these is true, with evidence, by tracing at the
adapter layer (log every raw provider message type, then every `RealtimeEvent` the adapter pushes):
- (a) OpenAI never sends `input_audio_buffer.speech_stopped` under this session config, or
- (b) it arrives but the adapter's message switch does not reach the new case, or
- (c) it reaches `onSpeechStopped` but the `if (!this.contextId) return` guard drops it.

Fix the one that is actually true. **Do not layer a speculative patch** — a previous attempt at
this bug was patched from a plausible-but-incomplete diagnosis and still failed live.

**2. `eos.turn_complete` arrives AFTER first audio** (24548 vs 22756 ms), so it cannot serve as a
fallback anchor at emit time. Once (1) is fixed this stops mattering; if (1) proves impossible on
some provider, the session needs an explicit native anchor rather than a silent no-emit.

**3. contextId changes twice** (`idle-*` -> UUID), and `llm.delta`/`tts.text` land on the `idle-*`
context while `tts.audio`/`eos` land on the UUID. The `turn.change` carry-forward
(`VoiceAgentSession.carryTurnTimingAcrossContextChange`) already merges these; verify it actually
does on the live path rather than assuming.

## The test-coverage trap — read this before writing tests

Every existing `turn_latency` unit test uses a **single hardcoded contextId**. The bug is *about*
identity changing mid-turn, so the entire suite was green while the feature had never once worked
on this path. 294 passing tests certified broken behavior.

Your tests must vary the contextId the way the bridge does (see the `rotates contextId mid-turn`
test in `packages/core/src/voice-agent-session.test.ts` for the shape). **A green suite is not
acceptance here.** The acceptance criterion is the live run below.

## Definition of done

- `SYRINX_SPIKE_ARM=native npx tsx scripts/spike-turn-decomposition-live.ts` prints a
  `turn_latency` event with a real `anchor` and a **non-empty stage breakdown** — not
  `(turn_latency never fired)`. Paste that output in your report.
- Cascade is unchanged: re-run `SYRINX_SPIKE_ARM=cascade` and confirm it still reports
  `ttfaMs` with `llmTtftMs`/`ttsTtfbMs`/`unattributedMs`.
- `pnpm --filter @kuralle-syrinx/{core,realtime,aisdk} test` and their typechecks: exit 0.
- Report which of (a)/(b)/(c) was true, with the evidence that established it.

## Hard rules

- No `--no-verify`, no `@ts-ignore`, no swallowed errors, no skipped tests.
- **If your fix does not make the live run emit, STOP and re-triage.** Do not add a second patch
  on top of a failed first one — that is how this bug survived the last attempt.
- You cannot verify Gemini live (keys do not work here); OpenAI Realtime does work.
- Never claim verified what you did not verify.
