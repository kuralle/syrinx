# Bound the toolNames map lifetime in fromGeminiLive

Repo: /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
File: `packages/realtime/src/from-gemini-live.ts`

## The bar

`toolNames` only ever gets `.set()` (per tool call) and `.get()` (per tool
result). There is no `delete`, no clear on turn boundary, no clear on session
close. The map grows for the whole life of a session — one entry per tool call,
forever. On a long call with frequent tool use that is unbounded memory growth.

Same leak class already fixed in the deepgram and tts-core adapters in 4.0.0. It
recurs because nothing structurally prevents it.

## Current shape — note this changed in `d353626`

The map is **no longer** `Map<string, string>`. As of the tool-id fix it is:

```ts
private readonly toolNames = new Map<string, { name: string; providerId: string | undefined }>();
```

Set in the tool-call ingest path, read in `injectToolResult`. Work against this
shape, not the one in the task description.

## Requirements

- REQ-1: Delete the entry once its result has been sent. The map's only purpose
  is to survive the round trip.
- REQ-2: Cap the map for entries whose result never arrives — an aborted or
  superseded turn must not pin entries indefinitely. Evict **oldest-first**.
- REQ-3: Clear the map in `close()` (around line 289) alongside the other
  per-session state.
- REQ-4: Evicting one entry must never disturb name resolution for a different
  in-flight call.
- REQ-5: No public API change.

## Mirror the existing eviction pattern

`packages/core/src/iu-ledger.ts` already does oldest-first eviction on a bounded
map — copy its shape rather than inventing a second convention:

```ts
private readonly maxContexts: number = 256,
...
if (!this.byCtx.has(ctx) && this.byCtx.size >= this.maxContexts) {
  const oldest = this.byCtx.keys().next().value;
  ...
}
```

Map insertion order is iteration order in JS, so `keys().next().value` is the
oldest. Pick a cap in the same spirit (256 is reasonable; state your choice).

## Definition of done

Extend `packages/realtime/src/from-gemini-live.test.ts`:

- Drive several tool call/result round trips; assert the map returns to size 0
  after each result.
- Drive tool calls whose results never arrive, past the cap; assert the size
  stays bounded **and that the evicted entries are the oldest** — assert which
  ids survive, not merely the size.
- Close the adapter with entries outstanding; assert the map is empty.
- Assert an in-flight call still resolves its name correctly after an unrelated
  eviction.

The map is private. Do **not** widen it to public or add a test-only getter on
the public API to observe size — prefer asserting observable behaviour (an
evicted id produces the existing `unknown tool id` error path; a surviving id
still resolves). If you genuinely cannot test it without exposure, say so in
`undisclosed_changes` rather than quietly widening the surface.

- **Sabotage, and report it:** remove the delete-on-result, confirm the
  round-trip test fails, restore. Quote the failure text.
- `pnpm --filter @kuralle-syrinx/realtime test` — **83 passing** before your
  change; must be greater, zero failures.
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` exits 0.

## Constraints

- Do **not** run any live smoke or live Gemini call. They cost credits, the
  manager runs them, and the Gemini Live smokes are currently broken for
  unrelated reasons. Do not fake output; do not list them in `claims`.
- Do not change the `functionResponses` construction or the `providerId` logic —
  that shipped in `d353626` and is not yours to revisit.
- Do not touch `packages/core` or `examples/`.

## DISCLOSURE REQUIREMENT

If you change behaviour this brief did not ask for, or add something you cannot
cover with a test, say so under `undisclosed_changes`. A silent untested
adaptation is a failed dispatch even with a green suite. If a requirement cannot
be met, write `runs/blocked-toolnames-lifetime.md` and stop.

## Result contract

Write `runs/result-toolnames-lifetime.json`:

```json
{
  "task": "Bound the toolNames map lifetime",
  "status": "done | blocked",
  "claims": [{"cmd": "<command>", "exit": 0, "note": "<what it proves>"}],
  "files_touched": ["..."],
  "cap_chosen": "<the cap and why>",
  "sabotage": "<what you broke, the failure text, that you restored it>",
  "undisclosed_changes": "<anything beyond the brief, or 'none'>"
}
```

Then write `done` to `runs/result-toolnames-lifetime.done`.
