# WT-02 / G14 — Canonical audio module + anti-aliased resampler

- **Status:** Ready · **Priority:** P1 · **Phase:** 0 (foundation)
- **Area:** audio / correctness · **Findings:** F2 (boundary leak), F3 (latent correctness)
- **Depends on:** — · **Blocks:** WT-01, WT-03, WT-07
- **Catalog:** G14

## Problem / Evidence

Two distinct problems in one surface:

1. **Boundary leak (F2).** μ-law and PCM/resample codecs are exported from a
   *carrier-specific* file and imported across the package:
   - `packages/voice-server-websocket/src/twilio.ts:761` `decodeMuLawToPcm16`,
     `:775` `encodePcm16ToMuLaw`, `:783` `resamplePcm16`, `:800` `pcm16SamplesToBytes`,
     `:809` `pcm16BytesToSamples`.
   - Imported by `telnyx.ts:13-19` and `smartpbx.ts:14-20`.
   - `index.ts:759` re-rolls its **own** `normalizePcm16` + `:781` `pcm16BytesToSamples`.
   - Telnyx additionally has big-endian variants (`telnyx.ts:825` `bigEndianPcm16BytesToSamples`,
     `:835` `pcm16SamplesToBigEndianBytes`).

2. **No anti-aliasing (F3).** `resamplePcm16` (`twilio.ts:783`) and `normalizePcm16`
   (`index.ts:759`) are pure linear interpolation. On **down-sample** paths —
   telephony outbound 16k/24k→8k, browser inbound 48k→16k — linear interpolation
   with no low-pass-before-decimation **aliases**. Per the Level-Up "networking
   problem" article and Deepgram guidance, bad interpolation silently degrades STT
   on fricatives/sibilants; clean-mic fixtures never catch it.

## Root cause (diagnose)

There was never a canonical audio layer, so each transport grew its own codec
helpers and the first one to need μ-law (`twilio.ts`) became the de-facto home.
The resampler was written for the easy (upsample/interpolate) case and reused on
the decimation path without an anti-alias filter.

## Proposed solution (rfc)

Create a canonical audio module in **`@asyncdot/voice`** (it already owns the
audio envelope + sample-rate contracts — the right layer):

```
packages/voice/src/audio/
  pcm.ts        # int16 <-> bytes (LE + BE), even-byte guard
  mulaw.ts      # decodeMuLawToPcm16 / encodePcm16ToMuLaw  (moved verbatim, then tested)
  resample.ts   # resamplePcm16 with anti-aliasing on down-sample
  index.ts      # re-exports
```

`resample.ts` requirements:
- Upsample: keep interpolation (band-limited or linear acceptable for upsample).
- **Down-sample: apply a low-pass FIR (windowed-sinc) with cutoff at
  `0.45 * targetRate` before decimation**, OR a polyphase resampler. Pick one and
  justify in `implementation-notes.md`. No raw linear-interp decimation.
- Pure function, deterministic, no allocation surprises in the hot path.

Then **delete** the duplicated copies from `twilio.ts` / `telnyx.ts` /
`smartpbx.ts` / `index.ts` and import from `@asyncdot/voice/audio`. Keep the
big-endian L16 variants in the module (Telnyx needs them). Breaking-change OK: if
any export signature changes, update all call sites in this PR.

## Acceptance criteria
- [x] One home for μ-law, PCM (LE+BE), and resample under `voice/src/audio/`.
- [x] All four transport files import from it; **zero** local codec re-declarations remain (`grep -c "function resamplePcm16\|function decodeMuLawToPcm16\|function normalizePcm16"` across `voice-server-websocket/src` == 0).
- [x] Down-sample path is anti-aliased; a spectral test proves attenuation above Nyquist.
- [x] `pnpm -r typecheck` and `pnpm -r test` green.

## Test plan (TDD + smoke)
- **Unit (write first, watch fail):**
  - μ-law round-trip within tolerance; LE/BE byte order; even-byte guard throws.
  - Resample identity (same rate → same samples), length math for up/down.
  - **Anti-alias spectral test:** synthesize a tone above the target Nyquist
    (e.g. 7 kHz into a 16k→8k path), FFT the output, assert the aliased image is
    ≥40 dB down vs the naive linear-interp baseline. This is the F3 regression lock.
- **Smoke (live):** re-run the live telephony adapter smoke
  (`smoke:telephony-university-live` for twilio/telnyx/smartpbx) and the live
  recorder coherence smoke; assert Whisper transcripts of recorded audio are still
  coherent (no regression from the new resampler) and capture the artifact paths.

## Definition of done
Single audio module, all callers migrated, anti-aliasing proven by spectral test,
telephony + recorder live smokes green with coherent Whisper output, decision on
FIR-vs-polyphase recorded in `implementation-notes.md`.

## Sources
Level-Up "Voice AI Has a Networking Problem" (codec hygiene); Deepgram Voice
Agent guide (telephony codec section); review findings F2, F3.
