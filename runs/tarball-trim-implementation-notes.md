# tarball-trim — implementation notes

## Goal restatement
Add identical `.npmignore` blacklist files to all 24 `packages/*` workspaces so published tarballs exclude `*.test.ts`, build artifacts, and junk — without dropping ONNX models, README, `index.html`, or `src/**`.

## Assumptions
- Blacklist approach (not `files` whitelist) is required because 3 packages ship ONNX models outside `src/`.
- No `package.json` edits needed; `.npmignore` is sufficient for npm pack exclusion.

## Decisions
- Created all 24 files via shell loop with heredoc to guarantee identical content.
- Verified silero-vad pack in addition to brief's proof table (DoD item 3).

## Pre-existing baseline note
`pnpm -r typecheck` exits 2 due to `examples/02-hello-voice-headless` (`playwright-core` module not found). All 24 `packages/*` typechecks passed. No source or package.json was modified — failure is unrelated to this change.

## Pack verification summary
| Package | src/index.ts | ONNX model | *.test.ts |
|---------|-------------|------------|-----------|
| @kuralle-syrinx/core | yes | n/a | 0 |
| @kuralle-syrinx/pipecat-smart-turn | yes | smart-turn-v3.2-cpu.onnx | 0 |
| @kuralle-syrinx/silero-vad | yes | silero_vad.onnx | 0 |