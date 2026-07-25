# Brief — LDT-11/12/13/14: the studio's four state surfaces

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`
Work on `main`. **Commit nothing** — leave changes in the working tree.

**You are the only worker in this repo right now. All four tasks are yours, in order.**
Do them one at a time and re-run the gate after each, so a break is attributable.

## Context (fetch these first)

- Design (FINAL): http://127.0.0.1:7526/api/v1/share/plandesk_share_FTZjpbaGLoPoKIAWZNRNkT5Cg2nghV65xjoGiHvcsiU.md
- Engineering plan (FINAL): http://127.0.0.1:7526/api/v1/share/plandesk_share_aNW6JJJ8Ngq-O9A7i9eNcQdFGM_9omB_j1WoDeYRMfo.md
- LDT-11 connection failure states: http://127.0.0.1:7526/api/v1/share/plandesk_share_NkzxjXzqwRb88-qkBWMWTvcPsJctYXBdYI7wQVQSZ1k.md
- LDT-12 mic permission/device: http://127.0.0.1:7526/api/v1/share/plandesk_share_HLoEdZ9hUzOc6UXEL5lZhSdJmRedmBRtCExgwfk-FCc.md
- LDT-13 persistent agent errors: http://127.0.0.1:7526/api/v1/share/plandesk_share_BnPIItZ54OHVGRnLQB0B8Qv196ly_wr5dPkedryAfn0.md
- LDT-14 session info panel: http://127.0.0.1:7526/api/v1/share/plandesk_share_G8C-I-S3EKwY3clhYimUmvYx2h0CcurpkVIWF62ddFs.md

Each share link carries the full task: Problem, Action Items, Done-when. **Read it before
starting that task.** The done-conditions are the acceptance criteria — not suggestions.

## Read first, match the idiom exactly

- `apps/studio/src/components/` — `Timeline.tsx`, `MetricsPanel.tsx`, `EventLog.tsx`,
  `TranscriptPanel.tsx`, `TextComposer.tsx` and their `.test.tsx` siblings.
- `apps/studio/src/hooks/useSyrinxSession.ts` — the single session hook. It already
  exposes `record`, `agentState`, `micActive`, `mode`, `textTurnIds`, `connect`,
  `disconnect`, `setMode`, `sendText`.
- `packages/browser-client/src/index.ts` — the `ready` message shape (~line 60) and the
  `error` message shape (~line 118).

Same card shape, same `data-testid` convention, same tone: **state what happened and what
to do about it**, never a bare status word.

## The standard these four are held to

This studio exists to tell a developer the truth about a voice session. Three rules,
learned the hard way in this codebase — a previous pass violated all three:

1. **Never fabricate a value.** No `0ms` for a stage that did not run, no empty bar, no
   placeholder that reads as a measurement. Absent is absent — say so in words.
2. **Never hide a real value either.** The inverse error is just as bad. If the backend
   measured it, show it. (A previous pass stripped a genuine 454ms TTS number believing
   it was fake. It was not.)
3. **Plain language only.** Never a packet or message name in user-facing text —
   no `eos.turn_complete`, `user.text_received`, `stt_output`, `tts_chunk`. Say what the
   machine did, in words a person reads.

## Hard requirements

- **No new dependencies.**
- **Do not modify `packages/**` or `examples/**`.** If you believe a change there is
  required, stop and say so in the result file instead of doing it.
- LDT-11's upgrade-rejected case must **derive** the Cloudflare route shape from
  `wrangler.jsonc` where readable — do **not** hardcode an agent name. The route is
  `/agents/<DO-class-name-in-kebab-case>/<id>`. This is design rule 6 and it is
  non-negotiable; a hardcoded name was already rejected once on this project.
- LDT-12: text mode must stay usable with **no microphone at all**. Also surface
  "audio arriving but not playing" as its own condition, distinct from silence.
- LDT-13: errors persist. Not a toast. Recoverable (e.g. a reasoner error the session
  survives) must be visually distinct from fatal.
- LDT-14 is read-only, straight off the `ready` message.

## Gate — all must exit 0, after each task

```
pnpm -C apps/studio typecheck
pnpm -C apps/studio test
pnpm -C apps/studio build
pnpm -r typecheck
```

Tests fold a real `SessionRecord` via `buildSessionRecord(...)`; see `Timeline.test.tsx`
and `MetricsPanel.test.tsx` for the pattern. Cover each done-condition explicitly:
each connection failure state distinguishable, a mocked `getUserMedia` rejection showing
its specific recovery instruction, an injected recoverable error rendering without
killing the view, and the info panel matching a `ready` message field for field.

## Command efficiency

NEVER re-run an expensive or slow command (test suites, builds, large greps, network/CLI
calls) just to change a pipe, filter, `grep`, `tail`, or `head`. Run it ONCE, capture the
FULL output to a uniquely-named temp file via `mktemp`
(`log=$(mktemp); cmd > "$log" 2>&1`), then grep/inspect `"$log"` as many times as needed.
Always use `mktemp`, never a fixed path, so concurrent agents never collide. Re-running a
heavy command to reshape its output is a bug.

## Result contract

Write `runs/result-ldt-11-14.json`:

```json
{ "status": "done | blocked",
  "tasks": { "LDT-11": "done|blocked", "LDT-12": "...", "LDT-13": "...", "LDT-14": "..." },
  "claims": [{ "command": "<exact command>", "exit_code": 0 }],
  "notes": "<anything you could not verify, and why>",
  "question": "<only when blocked>" }
```

`status: done` with no claims is invalid. **Claims are re-run by the engine; a claim whose
re-run differs is a false claim.** Never claim a command you did not personally run to
completion. If a done-condition could not be verified, say so in `notes` rather than
claiming it — an honest gap is useful, a false claim is not.
