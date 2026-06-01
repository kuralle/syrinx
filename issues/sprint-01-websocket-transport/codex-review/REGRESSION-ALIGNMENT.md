# REGRESSION-ALIGNMENT

## Final verdict

- Class A audit result: 3 confirmed unsafe/suspect direct PCM conversions found in package source; 2 fixed in this review, 1 was already fixed by `3535ca0`.
- Class B audit result: browser binary-envelope ingress had envelope-forwarding tests, but no test proved the decoded odd-offset payload reached the VAD branch. Added focused coverage.
- Current package-source direct `new Int16Array(x.buffer, x.byteOffset, ...)` count in named production packages: 0.
- Audio ingress is alignment-safe by construction for the audited package paths: browser envelope decode may preserve odd byte offsets, but VAD/EOS consumers now use `pcm16BytesToSamples` or do not construct aligned typed views.

## Findings

| id | file:line | class | verdict | evidence / repro | severity |
|---|---:|---|---|---|---|
| A-001 | `packages/voice-turn-pipecat/src/index.ts:169` | A | CONFIRMED-REAL | `PipecatEOSPlugin` consumed `vad.audio` from the same bus path as Silero. The new regression `packages/voice-turn-pipecat/src/index.test.ts:276` fed a `Uint8Array.subarray(1)` frame; before the fix the predictor received no samples. Fixed with `pcm16BytesToSamples`. | High |
| A-002 | `packages/voice-vad-silero/src/index.ts:89` | A | ALREADY-SAFE | Historical production crash site fixed by `3535ca0`; current code uses `pcm16BytesToSamples`. Existing odd-offset regression remains in `packages/voice-vad-silero/src/index.test.ts:152`. | High historical |
| A-003 | `packages/voice/src/primary-speaker-fixtures.ts:34` | A | CONFIRMED-REAL | Public synthetic PCM mixer used the same unsafe constructor. It is not live browser ingress, but direct odd-offset input reproduced the class. Fixed with `pcm16BytesToSamples`; regression added in `packages/voice/src/primary-speaker-gate.test.ts`. | Low |
| A-004 | `packages/voice/src/audio/pcm.ts:7` and `:28` | A | ALREADY-SAFE | Canonical PCM byte readers use `DataView(audio.buffer, audio.byteOffset, audio.byteLength)` and copy into fresh `Int16Array`s. `DataView` does not require 2-byte alignment. | None |
| A-005 | `packages/voice/src/audio-envelope.ts:44` and `:57` | A/B | ALREADY-SAFE | Envelope decoder uses `DataView` for header metadata and deliberately returns `data.subarray(headerEnd)`. This is safe locally but creates the dirty odd-offset payload downstream tests must exercise. | Medium blindspot source |
| A-006 | `packages/voice-server-websocket/src/index.ts:735` and `:755` | A/B | ALREADY-SAFE | WebSocket ingress preserves Node `Buffer.byteOffset`, then forwards decoded envelope `.audio`. No typed-array sample view is constructed here; the new test at `packages/voice-server-websocket/src/index.test.ts:1296` proves an odd-offset envelope reaches `vad.audio`. | Medium blindspot source |
| A-007 | `packages/voice-client-browser/src/audio.ts:85`, `:93`, `:119`, `:183` | A | ALREADY-SAFE | Browser client creates byte views over fresh PCM arrays or converts playback `ArrayBuffer`s. `AudioJitterBuffer.enqueue` accepts an `ArrayBuffer`, not a sub-offset view. | None |
| A-008 | `packages/voice-client-browser/src/index.ts:244` and `:280` | A | ALREADY-SAFE | Browser uplink preserves view bytes for framing/envelope encoding only; it does not construct PCM sample typed views over arbitrary byte offsets. | None |
| A-009 | `packages/voice-server-websocket/src/browser-opus.ts`, `packages/voice-server-websocket/src/smartpbx.ts`, `packages/voice-client-browser/src/browser-opus.ts` | A | ALREADY-SAFE | Remaining `Int16Array` constructors allocate fresh buffers or copy from existing `Int16Array` remainders; no `buffer + byteOffset` sample view over network bytes. | None |
| A-010 | `packages/voice-stt-deepgram/src`, `packages/voice-recorder/src`, `packages/voice-tts-*`, `packages/voice-ws/src` | A | ALREADY-SAFE | Audit found no direct PCM sample typed-array construction from `Uint8Array.buffer + byteOffset`; these paths pass bytes through, copy bytes, or write bytes. | None |
| A-011 | `examples/02-hello-voice-headless/**` direct WAV helpers | A | FALSE-POSITIVE | Several scripts construct `Int16Array` views over freshly merged `Uint8Array`s or `readFileSync` buffers for WAV writing. They are outside the named package runtime ingress and were not changed. | Low residual |
| B-001 | `packages/voice-server-websocket/src/index.test.ts:1228` | B | CONFIRMED-REAL | Existing binary-envelope test proved `user.audio_received` forwarding/resampling with aligned fixtures, but not envelope decode -> VAD on an odd-offset payload. Fixed by `VadAlignmentProbe` and test at `packages/voice-server-websocket/src/index.test.ts:1296`. | High |
| B-002 | `packages/voice-turn-pipecat/src/index.test.ts:36` | B | CONFIRMED-REAL | Pipecat EOS tests exercised STT/VAD boundary events, but no odd-offset `vad.audio` frame. Fixed by the new regression at `packages/voice-turn-pipecat/src/index.test.ts:276`. | High |
| B-003 | carrier e2e/tests | B | CONFIRMED-REAL | Carrier paths decode base64/mu-law into fresh aligned PCM buffers, so they could not expose browser envelope subarray alignment. Browser envelope coverage now exists separately. | Medium |
| B-004 | websocket metadata invariants | B | ALREADY-SAFE | Existing server tests cover malformed odd-byte PCM payloads, sample-rate changes, duration mismatch, and sequence regressions for JSON and binary envelope paths. | None |

## Verification

- Red/green: `pnpm --filter @asyncdot/voice-turn-pipecat test -- --runInBand` failed before the Pipecat fix because the odd-offset frame produced an empty predictor input; passed after the fix.
- Focused package tests/typecheck passed:
  - `pnpm --filter @asyncdot/voice-turn-pipecat test -- --runInBand`
  - `pnpm --filter @asyncdot/voice-turn-pipecat typecheck`
  - `pnpm --filter @asyncdot/voice test -- src/primary-speaker-gate.test.ts src/audio/audio.test.ts`
  - `pnpm --filter @asyncdot/voice typecheck`
  - `pnpm --filter @asyncdot/voice-server-websocket test -- src/index.test.ts`
  - `pnpm --filter @asyncdot/voice-server-websocket typecheck`
- Full suite passed twice:
  - `pnpm -r test`
  - `pnpm -r test`
- Live envelope smoke:
  - Deployed `wss://syrinx-studio-mcj.fly.dev/ws` still failed with `start offset of Int16Array should be a multiple of 2`; this indicates the deployed image is stale relative to this review.
  - Local studio from the current workspace passed `SYRINX_STUDIO_E2E_URL=ws://127.0.0.1:4173/ws node .handoff/studio-e2e-test.mjs --envelope`: 11 STT interim frames, 3 agent chunks, 183 TTS audio frames, zero errors.

## Residual risk

- The deployed Fly studio must be redeployed from a commit containing `d5a0c53` or later before the deployed browser-envelope path is safe.
- Example scripts still contain direct typed-array views over fresh merged/read-file buffers. They are not the production browser ingress path, but they should be converted to `pcm16BytesToSamples` if those scripts start consuming subarray/network buffers.
