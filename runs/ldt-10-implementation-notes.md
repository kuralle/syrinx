# LDT-10 / LDT-3 — implementation notes

## Load-bearing correction: text mode does NOT bypass TTS

My brief to the worker asserted "text mode bypasses STT, endpointing and TTS".
The first two are true; **the third is false**, and the worker built on it.

`handleUserText` (`packages/core/src/voice-agent-session.ts:876`) pushes an
immediate `eos.turn_complete` into the *normal* pipeline. The reasoner runs, and
so does the voice.

Verified live, not reasoned (`runs/ldt10-textmode-probe.mjs`, against `dev:server`):

    sawTtsChunk: true, sawTtsEnd: true, ttsBytes: 108512
    metrics: { textReadyMs, firstAudioByteMs, firstAudioPlayedMs,
               lastAudioPlayedMs, ttsTTFBMs: 454 }
    (no speechEndMs, no sttMs, no e2eMs, no llmTTFTMs)

### Consequences

1. **`withoutAudioStages` was deleting real data.** It stripped `ttsTTFBMs` and
   the audio-played marks, which are genuine measurements for a typed turn.
   Hiding a real number is the same lie as fabricating one, pointed the other
   way. `apps/studio/src/lib/text-mode.ts` deleted.
2. **`TextLane` rendered `llmTTFTMs`**, which is `undefined` for a typed turn
   (it needs `sttFinalMs`). So the lane showed nothing, having deleted the one
   real number that existed. Replaced with the normal `Lane` + a note.
3. **The zero-fabrication worry was unfounded.** `positiveDelta`
   (`turn-metrics.ts:48`) returns `undefined` when either endpoint is `<= 0`, so
   the server already omits marks it never measured. Nothing to defend against.
4. **UI copy corrected** — it claimed "nothing speaks the reply". A developer
   told the reply is silent will not think to listen to it.

## Second defect found while verifying

`Timeline` labelled the `textReady -> firstAudioByte` segment **"Thinking"**;
`MetricsPanel` calls that same field **"Voice (to first audio)"**. Thinking has
already finished at `textReady` — the segment is time-to-first-audio. Two panels
naming one quantity two different things. Fixed in `turn-timeline.ts`; the
neighbouring label absorbed the thinking phase it actually covers.

## LDT-3 deviation

Spec said `apps/studio/src/lib/recorder.ts`. Built as
`packages/browser-client/src/turn-recorder.ts` (subpath `./turn-recorder`)
instead, because it is pure, DOM-free and Node-testable — the same class of
module as LDT-2's `/record`, and it belongs to the SDK others build their own
studio on. Also avoided a same-package collision with the live LDT-10 worker.

Pre-roll (300ms default) is load-bearing: VAD announces speech *after* onset, so
a recorder that starts buffering on `speech_started` clips the first phoneme, and
a fixture missing its onset transcribes differently from the turn it came from.

Studio wiring of the recorder is **not** done — that is LDT-4 (fixture capture),
which is human-gated on a microphone.
