# Brief — LDT-6: Build the event log panel

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`
Work on `main`. Commit nothing — leave changes in the working tree for review.

## Context (fetch these; do not work from this brief alone)

- Task: http://127.0.0.1:7526/api/v1/share/plandesk_share_fREkrwAXBtX9KnBMRmD8eVXeRES16IsGUZzDPV7In3k.md
- Design (FINAL): http://127.0.0.1:7526/api/v1/share/plandesk_share_FTZjpbaGLoPoKIAWZNRNkT5Cg2nghV65xjoGiHvcsiU.md
- Engineering plan (FINAL): http://127.0.0.1:7526/api/v1/share/plandesk_share_aNW6JJJ8Ngq-O9A7i9eNcQdFGM_9omB_j1WoDeYRMfo.md

## What already exists — read it first, and copy its idiom

Three sibling features shipped in the last hour. **Match their structure exactly.**

- `packages/browser-client/src/session-record.ts` — the `SessionRecord` you render. Pure reducer.
- `apps/studio/src/components/Timeline.tsx` + `Timeline.test.tsx` — the closest analogue. Same card shape, same `data-testid` convention, same empty-state treatment.
- `apps/studio/src/hooks/useSyrinxSession.ts` — exposes `record`. Do not re-derive anything from raw messages; read `record`.

## Build

`apps/studio/src/components/EventLog.tsx` + `EventLog.test.tsx`, mounted in `routes/SessionView.tsx`.

Reads `SessionRecord`. Every event lives at `record.turns[].events[]` and `record.sessionEvents[]`, each `{ atMs, message }`.

1. Timestamped stream, newest-relevant ordering, showing `atMs`, `message.type`, and `turnId` where present.
2. **Filter by type and by turn.**
3. **Hide per-frame noise by default** behind a count — e.g. "142 audio frames hidden" with a toggle. `tts_chunk` will otherwise drown everything. This is the single most important behaviour in this panel.
4. Expandable payload per event (JSON).
5. A "copy turn as JSON" action.

## Hard requirements

- **Never print packet names as user-facing labels** in headings or empty states. Inside the raw event rows the type string is the data, so it is fine there — that is the point of the panel.
- **Unknown message types must render.** The Cloudflare agents SDK emits `cf_agent_identity` / `cf_agent_mcp_servers`, which are not in the `SyrinxStudioMessage` union. A test must cover one.
- **Empty state teaches** — say what will appear and how to produce it, like `Timeline.tsx` does.
- No new dependencies.

## Gate — all must exit 0

```
pnpm -C apps/studio typecheck
pnpm -C apps/studio test
pnpm -C apps/studio build
pnpm -r typecheck
```

Component tests must fold a real `SessionRecord` via `buildSessionRecord(...)` — see `Timeline.test.tsx`. Do not hand-construct a record literal.

## Result contract

Write `runs/result-ldt-6.json`:

```json
{ "status": "done | blocked",
  "claims": [{ "command": "<exact command>", "exit_code": 0 }],
  "question": "<only when blocked>" }
```

`status: done` with no claims is invalid. Every claim is re-run by the engine; a claim whose re-run differs is a false claim and fails the dispatch. Do not claim a command you did not run.
