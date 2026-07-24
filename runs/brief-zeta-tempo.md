# Brief — Zeta TTS: pitch-preserving tempo control (WSOLA)

Worker task on branch `feat/half-cascade`. Add an optional, pitch-preserving time-stretch to the Zeta
plugin so Sinhala output can be slowed (its prosody rushes). Verified need: ffmpeg `atempo=0.90` (10%
slower, pitch preserved) sounds right; we want that baked in without an ffmpeg runtime dependency.

## Standards (hard)
- No workarounds, root-cause only. No done without the verify commands passing.
- Touch ONLY `packages/zeta-tts/src/` (add `wsola.ts`, edit `index.ts`, add tests). No other packages.
- Command efficiency: run heavy commands ONCE, capture to a `mktemp`, inspect that.

## Deliverable 1 — streaming WSOLA time-stretcher (`packages/zeta-tts/src/wsola.ts`)
`export class WsolaTimeStretch` — pitch-preserving time-scale on a streaming Int16Array PCM signal:
- `constructor(tempo: number, sampleRateHz: number)` — `tempo` is playback-rate like ffmpeg `atempo`:
  `tempo < 1` slows down, `> 1` speeds up, `1.0` = passthrough. Output length ≈ input length / tempo.
- `process(input: Int16Array): Int16Array` — feed a chunk, get whatever whole output frames are ready
  (buffer the remainder internally across calls — this is STREAMING, chunks are arbitrary sizes).
- `flush(): Int16Array` — emit the tail at end of stream.

Algorithm (standard WSOLA — do NOT just resample, that changes pitch):
- Hann window, frame ≈ 30 ms (`round(0.03 * sampleRateHz)`), 50% synthesis overlap (COLA).
- Synthesis hop `Hs = frame/2` (fixed). Analysis hop `Ha = round(Hs * tempo)`.
- For each output frame: search input positions within ±(10 ms) of the ideal analysis point for the
  segment whose overlap region best cross-correlates with the previous frame's natural continuation
  (this is the "WS" in WSOLA — it removes phase-discontinuity clicks). Window it, overlap-add at the
  synthesis position, advance output by `Hs`, advance the ideal analysis point by `Ha`.
- `tempo === 1` (within 1e-6): pure passthrough (return input as-is), zero cost.
- Clamp samples to int16 on overlap-add.

## Deliverable 2 — wire into `ZetaTTSPlugin` (`index.ts`)
- Read config `tempo` (default `1.0`); clamp to `[0.5, 1.5]`. Store it.
- After the resampler (`const resampled = resampler.process(samples)` ~line 141), pass through a
  per-request `WsolaTimeStretch(this.tempo, this.sampleRate)` when `tempo !== 1`: emit
  `stretcher.process(resampled)` as the tts.audio payload. Before `emitEnd`, emit `stretcher.flush()`
  as a final tts.audio chunk if non-empty. When `tempo === 1`, behavior is byte-identical to today.

## Red gate FIRST (deterministic — no audio files)
`packages/zeta-tts/src/wsola.test.ts`:
1. **Length scaling:** feed a 1 s 220 Hz sine at 24 kHz through `tempo=0.9`; assert output length is
   within ±1 frame of `inputLen / 0.9` (≈1.111 s). Same for `tempo=1.2` (shorter).
2. **Pitch preserved:** for the `tempo=0.9` output sine, measure the zero-crossing period; assert it
   matches the input's period within ~5% (pitch unchanged — the whole point).
3. **Passthrough:** `tempo=1.0` returns the input samples unchanged (same length, same values).
4. **Streaming invariance:** feeding the signal in one big chunk vs many small chunks yields the same
   total output length (±1 frame).
Also add one `index.test.ts` case: a `tempo: 0.9` config produces MORE total tts.audio bytes than
`tempo: 1.0` for the same mocked Zeta PCM stream.

## Verify (write exit codes to `runs/proof-zeta-tempo.txt`)
```
pnpm --filter @kuralle-syrinx/zeta-tts typecheck
pnpm --filter @kuralle-syrinx/zeta-tts test
```
Do not commit or push. Report exit codes + the new test names.
