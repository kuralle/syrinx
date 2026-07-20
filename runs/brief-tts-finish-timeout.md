# Brief — Fix: TTS finish-timeout truncates long turns (half-cascade)

Worker task on branch `feat/half-cascade`. DIAGNOSE INDEPENDENTLY FIRST, then fix + regression-test.
Do not just trust the analysis below — confirm it in the code and with a failing test before fixing.

## Standards (hard)
- No workarounds, root-cause only. No done without the verify commands passing.
- Touch ONLY `packages/tts-core/src/engine.ts` + its test(s).
- Command efficiency: run heavy commands ONCE, capture to a `mktemp`, inspect that.

## Symptom (reproduced live)
Half-cascade TTS audio (Cartesia) is truncated MID-SENTENCE. Evidence gathered:
- STT of the output ends mid-sentence ("…requires a late registration" — no period).
- Collecting audio for 2s AFTER `tts.end`: zero further audio — so the pipeline genuinely STOPS at `tts.end`,
  it is not a collection race.
- Setting the Cartesia plugin `finish_timeout_ms` from its default 2000 → 20000 makes the audio COMPLETE
  (ends with a proper sentence + period). So the finish timeout is force-ending the turn early.

## Suspected root cause (VERIFY yourself)
In `packages/tts-core/src/engine.ts`, `onDone()` schedules a FIXED `finishTimeoutMs` timer
(`scheduleFinishTimeout`) when the flush is sent. Incoming `audio` wire events (`dispatch` → `handleAudio`,
the `"audio"` case) do NOT reset that timer — `clearFinishTimeout` is only called on natural end
(`tryEmitEnd`), cancel, or fail. So it is a fixed guillotine from `tts.done`, not an inactivity watchdog.
Half-cascade hits it because the realtime front dumps its whole text at once → `tts.done` fires early →
the TTS has a large backlog to synthesize, and the 2s fixed timer cuts it mid-stream.

Confirm this is true before changing anything (read the schedule/clear call sites; note there is an
injected `timer` + `now()` so tests can use a fake clock).

## Fix (make the safety net inactivity-based)
The finish timeout should fire only after `finishTimeoutMs` of TTS **silence** (a genuinely wedged
provider), never during active streaming. So: when an `audio` event is handled for a context that is in
`pendingEnd` (i.e. flush already sent, awaiting the provider's done ack), **reschedule** the finish timeout
(clear + schedule again). Do NOT arm it before flush (there is no finish timer pre-`onDone`). Keep the
default 2000 unchanged — 2000 now means "2s of silence after flush = wedged".

## Red gate FIRST (deterministic, using the injected fake timer/clock — no real sleeps)
Add engine test(s) that would FAIL before the fix:
1. **No premature end during active streaming:** flush a context (`onDone`), then deliver `audio` wire
   events with the fake clock advanced by `finishTimeoutMs - ε` between each, past a total of
   `> finishTimeoutMs`. Assert `tts.end` is NOT emitted while audio keeps arriving, and no audio is dropped.
2. **Safety net preserved:** flush a context, deliver NO audio, advance the fake clock by `finishTimeoutMs`.
   Assert `tts.end` IS emitted (wedged-provider recovery still works).
3. Existing behavior (natural `context_end` / `done` ends the context immediately) still passes.

## Verify (write exit codes to `runs/proof-tts-finish-timeout.txt`)
```
pnpm --filter @kuralle-syrinx/tts-core typecheck
pnpm --filter @kuralle-syrinx/tts-core test
pnpm --filter @kuralle-syrinx/deepgram test
pnpm --filter @kuralle-syrinx/cartesia test
```
(deepgram + cartesia use tts-core — confirm no regression.) Do not commit or push. Report exit codes +
whether your independent diagnosis matched, and the new test names.
