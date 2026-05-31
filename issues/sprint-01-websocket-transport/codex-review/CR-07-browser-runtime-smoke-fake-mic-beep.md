# CR-07 — Browser runtime smoke used synthetic fake mic beep, causing no STT turn

- **Status:** Fixed
- **Severity:** high
- **Area:** smoke reliability / browser transport

## Problem / Evidence

Runtime smoke launched Chrome with `--use-fake-device-for-media-stream` but no fake audio file, so the mic source was a synthetic tone rather than speech.

- `examples/02-hello-voice-headless/scripts/run-browser-runtime-capture-smoke.ts:197-199`

This causes silent STT behavior and turn timeouts in real smoke runs.

## Root cause

Chrome launch path omitted `--use-file-for-fake-audio-capture=<speech.wav>`.

## Proposed solution

Add a deterministic speech WAV fixture to Chrome launch args (override-able via env var), and regression-test that launch args always include it.

## Acceptance criteria

- [x] Chrome launch args include `--use-file-for-fake-audio-capture=`.
- [x] Default path points to a repository speech fixture.
- [x] Regression test protects against future removal.

## Test plan

- `examples/02-hello-voice-headless/test/browser-runtime-smoke-launch.test.ts`

## Definition of done

Browser runtime smoke uses speech input rather than synthetic tone, enabling deterministic STT turn creation.

## Fix notes

- Fixed in:
  - `examples/02-hello-voice-headless/scripts/run-browser-runtime-capture-smoke.ts`
  - `examples/02-hello-voice-headless/test/browser-runtime-smoke-launch.test.ts`
