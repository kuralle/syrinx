# Brief — LDT-10: Add text mode to the studio

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`
Work on `main`. Commit nothing — leave changes in the working tree.

**You are the only worker in `apps/studio` right now. Do not touch `examples/` — another task is live there.**

## Context (fetch these)

- Task: http://127.0.0.1:7526/api/v1/share/plandesk_share_ktZvVOEJJ0Snfsf0llRb5gGUT8gOVyr_p0U2cSftXO8.md
- Design (FINAL): http://127.0.0.1:7526/api/v1/share/plandesk_share_FTZjpbaGLoPoKIAWZNRNkT5Cg2nghV65xjoGiHvcsiU.md
- Engineering plan (FINAL): http://127.0.0.1:7526/api/v1/share/plandesk_share_aNW6JJJ8Ngq-O9A7i9eNcQdFGM_9omB_j1WoDeYRMfo.md

## Already wired end to end — this is UI only

`SyrinxBrowserClient.sendText()` (`packages/browser-client/src/index.ts:326`) → `{type:"text"}` → `user.text_received` (`packages/server-websocket/src/edge.ts:531`) → `handleUserText` pushes `eos.turn_complete` (`packages/core/src/voice-agent-session.ts:878`) → the reasoner runs.

**Verified live on both runtimes** — do not add a second path or re-implement ingress.

## Read first, match the idiom exactly

`apps/studio/src/components/` — `Timeline.tsx`, `EventLog.tsx`, `TranscriptPanel.tsx`, `MetricsPanel.tsx` and their `.test.tsx` siblings. Same card shape, same `data-testid` convention, same "state the trade" tone. `apps/studio/src/hooks/useSyrinxSession.ts` exposes `record`, `agentState`, `micActive`, `connect`, `disconnect`.

## Build

1. **Text composer** — Enter sends via `client.sendText`, disabled while disconnected, clears on send. The typed text appears as a user turn (it comes back as `stt_output`, so the record already handles it — do not fake a local echo).
2. **Mode toggle, voice ↔ text**, without resetting the session. History must be continuous across a switch; the record is not cleared.
3. **Switching to text visibly releases the microphone**; switching back re-requests it. The user must be able to see the mic is off — a silently-hot mic is the failure here.
4. **State the trade in the UI.** Text mode bypasses STT, endpointing and TTS, so transcription errors, turn-taking and barge-in are *untested*. Say it plainly where the user will read it.

## Hard requirements

- Metrics/timeline in text mode must **omit** audio stages, not show them as `0ms`. Zeroes read as "instant", which is a lie. If that needs a prop or flag, add it — do not fabricate values.
- Plain language. Never `eos.turn_complete`, `user.text_received`, etc. in user-facing text.
- No new dependencies.
- Do not modify `packages/**` or `examples/**`.

## Gate — all must exit 0

```
pnpm -C apps/studio typecheck
pnpm -C apps/studio test
pnpm -C apps/studio build
pnpm -r typecheck
```

Tests fold a real `SessionRecord` via `buildSessionRecord(...)`; see `Timeline.test.tsx`. Cover: send-on-Enter, disabled-while-disconnected, history continuity across a mode switch, mic released on switch to text, and the trade-statement being present.

## Result contract

Write `runs/result-ldt-10.json`:

```json
{ "status": "done | blocked",
  "claims": [{ "command": "<exact command>", "exit_code": 0 }],
  "question": "<only when blocked>" }
```

`status: done` with no claims is invalid. Claims are re-run by the engine; a claim whose re-run differs is a false claim. **Never claim a command you did not personally run to completion.**
