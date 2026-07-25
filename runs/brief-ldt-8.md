# Brief — LDT-8: Fix transcript fidelity (interim, barge-in, tool cues)

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`
Work on `main`. Commit nothing — leave changes in the working tree for review.

## Context (fetch these; do not work from this brief alone)

- Task: http://127.0.0.1:7526/api/v1/share/plandesk_share_m1pPhdzJc8QoDlBzcH7Nl2OY_Z1AHoqQhLvsafjRObE.md
- Design (FINAL): http://127.0.0.1:7526/api/v1/share/plandesk_share_FTZjpbaGLoPoKIAWZNRNkT5Cg2nghV65xjoGiHvcsiU.md
- Engineering plan (FINAL): http://127.0.0.1:7526/api/v1/share/plandesk_share_aNW6JJJ8Ngq-O9A7i9eNcQdFGM_9omB_j1WoDeYRMfo.md

## The problem in one line

The transcript shows text and loses everything that explains it. `agent_interrupted` carries a **reason** and is discarded. All four `tool_call_*` phases are discarded. Interim and final look identical.

## What already exists — read it first

- `packages/browser-client/src/session-record.ts` — **already parses all of this.** `TurnRecord` has `userInterim`, `userTranscript`, `userConfidence`, `agentText`, `toolCalls[]` (with `phase` and `afterMs`), `interrupted` (with `atMs`/`reason`), `errors[]`. **Do not re-parse messages** — read the record.
- `apps/studio/src/lib/transcript.ts` — today's reducer, which handles only 4 message types.
- `apps/studio/src/components/Timeline.tsx` + `.test.tsx` — the idiom to match.
- `apps/studio/src/hooks/useSyrinxSession.ts` — exposes `record`.

## Build

Rework `TranscriptPanel` (and `transcript.ts` if it still earns its place) to render from `SessionRecord.turns`:

1. **Interim visibly provisional** — muted/italic — and **replaced in place** by the final. Show `userConfidence` when present.
2. Group user/agent turns by `turnId`.
3. **Barge-in inline at the point of interruption**, showing the reason and **the elapsed time from the start of the turn to the interruption** (`interrupted.atMs` minus `startedAtMs`). That number is what decides whether barge-in feels responsive — it is the point of the feature.
4. **All four tool-cue phases**: `started` arms an indicator, `delayed` escalates it (show `afterMs`), `complete`/`failed` clear it. Tool name, args and result inspectable. **A failed tool must look different from a slow one.**

## Hard requirements

- Read `record`, never raw messages. If something you need is missing from `TurnRecord`, say so in `question` and stop — do not add a second parser.
- Plain language in labels. Never `eos.turn_complete`, `tool_call_delayed`, etc. in user-facing text.
- Keep existing `transcript.ts` tests passing, or delete tests only if the code they cover is genuinely gone — and say which in your result.
- No new dependencies.

## Gate — all must exit 0

```
pnpm -C apps/studio typecheck
pnpm -C apps/studio test
pnpm -C apps/studio build
pnpm -r typecheck
```

Tests must fold a real `SessionRecord` via `buildSessionRecord(...)` — see `Timeline.test.tsx`. Cover: interim→final replacement, interruption placement with elapsed time, and each of the four cue phases.

## Result contract

Write `runs/result-ldt-8.json`:

```json
{ "status": "done | blocked",
  "claims": [{ "command": "<exact command>", "exit_code": 0 }],
  "question": "<only when blocked>" }
```

`status: done` with no claims is invalid. Every claim is re-run by the engine; a claim whose re-run differs is a false claim and fails the dispatch. Do not claim a command you did not run.
