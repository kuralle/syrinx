# CR-06 — Interactive websocket smoke assumed PCM16 bytes on Opus downlink

- **Status:** Fixed
- **Severity:** high
- **Area:** smoke validity / quality-gate correctness

## Problem / Evidence

The interactive smoke counted assistant binary bytes as PCM16 and derived duration with `bytes/2/sampleRate`, which is invalid when browser downlink is Opus.

- `examples/02-hello-voice-headless/scripts/run-websocket-university-interactive.ts:144`
- `examples/02-hello-voice-headless/scripts/run-websocket-university-interactive.ts:205`
- `examples/02-hello-voice-headless/scripts/run-websocket-university-interactive.ts:504`

With Opus enabled on browser websocket legs, this produced false failures and wrong artifacts.

## Root cause

Smoke evaluator and artifact writer were wired to a single audio encoding assumption (`pcm_s16le`) while transport supports both PCM and Opus.

## Proposed solution

Track assistant encoding from `tts_chunk`, branch thresholds/duration logic by encoding, and only apply PCM byte-floor checks to PCM turns.

## Acceptance criteria

- [x] Smoke captures assistant encoding per turn.
- [x] PCM-only byte-floor check is not applied to Opus turns.
- [x] Artifact baseline/manifest carry correct assistant encoding and duration logic.
- [x] Regression test locks Opus behavior.

## Test plan

- `examples/02-hello-voice-headless/test/websocket-smoke-quality-gates.test.ts`
  - Added Opus turn case to ensure no false PCM floor failure.

## Definition of done

Interactive smoke no longer fails from codec mismatch when assistant downlink is Opus.

## Fix notes

- Fixed in:
  - `examples/02-hello-voice-headless/scripts/run-websocket-university-interactive.ts`
  - `examples/02-hello-voice-headless/test/websocket-smoke-quality-gates.test.ts`
