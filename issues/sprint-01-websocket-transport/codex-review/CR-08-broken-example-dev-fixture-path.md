# CR-08 — Example `dev` script pointed to non-existent WAV fixture path

- **Status:** Fixed
- **Severity:** medium
- **Area:** developer ergonomics / example correctness

## Problem / Evidence

The example package `dev` script targeted `public/fixtures/hello.wav`, but `public/fixtures` does not exist in this package.

- `examples/02-hello-voice-headless/package.json:8`

This breaks first-run local validation for the example.

## Root cause

Stale script path after fixture layout changes.

## Proposed solution

Point `dev` to an existing speech fixture under `test/fixtures`.

## Acceptance criteria

- [x] `pnpm --filter @asyncdot-example/02-hello-voice-headless dev` resolves a real WAV file path.

## Test plan

- Script path verified against repository fixture existence.

## Definition of done

Example starts from a valid fixture path without manual file creation.

## Fix notes

- Fixed in:
  - `examples/02-hello-voice-headless/package.json`
