# Make Route.Main overflow degrade instead of throwing

Repo: /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
File: `packages/core/src/pipeline-bus.ts`

## The bar

`PipelineBus.push` **throws** when Main hits `mainCapacity` (4096):

```
PipelineBus: Main queue full (4096). Backpressure required — slow down producers or increase capacity.
```

On a live call that is a crash, not backpressure — no caller is positioned to
catch it and recover, so a producer burst takes the session down. Every other
route already degrades: `Critical` is unbounded, `Background` drops oldest, and
`Media` drops oldest with a metric and never throws. Main is the only lane that
aborts.

**This is a guard, not a load-shedding policy.** Measured post-migration, one
realistic turn puts **66** packets on Main (60 `llm.delta` + 6 `tts.text`)
against a 4096 capacity — roughly 62 turns of completely undrained backlog before
the throw is even reachable. Keep the change small and well-tested. Do not build
a scheduler.

## Requirements

- REQ-1: `push` on a full Main queue **never throws**. It drops the **oldest**
  packet and enqueues the new one, exactly as `Media` does.
- REQ-2: Emit `pipeline.bus.main.dropped` on the Background route, mirroring the
  existing `pipeline.bus.media.dropped`.
- REQ-3: Add `onMainDrop?: (dropped: VoicePacket) => void` to `PipelineBusConfig`,
  mirroring `onBackgroundDrop` / `onMediaDrop`.
- REQ-4: Make the drop **loud**. A Main drop means the session is already in
  trouble — a lost `llm.delta` or `tts.text` is a turn the caller experiences as
  broken. Emit at a severity that surfaces, and say so in the doc comment. This
  is deliberately unlike a Background drop, which is routine.
- REQ-5: `push()` and `on()` signatures unchanged; `mainCapacity` keeps its 4096
  default.

## Explicitly out of scope

Action item 5 of the task floats superseding an in-flight turn instead of losing
packets from its middle. **Do not implement that.** It is out of proportion to a
guard that needs 62 turns of backlog to reach, and it risks stripping `Critical`
semantics queued behind Main work. If you believe it is necessary, write
`runs/blocked-main-overflow.md` explaining why and stop.

## Definition of done

- New test (new file, or added to `pipeline-bus.test.ts` — your call):
  - fill Main past `mainCapacity` with the drain loop stalled;
  - assert `push` never throws;
  - assert the **oldest** packets are dropped and the newest survive;
  - assert `onMainDrop` fires per drop;
  - assert `pipeline.bus.main.dropped` is emitted;
  - **assert the session recovers** — after releasing the stall, a subsequent
    packet is dispatched normally. A guard that trades a crash for a wedge has
    not fixed anything.
- `pipeline-bus.test.ts` and `pipeline-bus.g10.test.ts` must pass. One of them
  may currently assert the throw. If so, that single assertion is the deliberate
  behaviour change — update **only** that case and **say so explicitly** in your
  result under `undisclosed_changes`. Do not edit any other assertion.
- **Sabotage, and report it:** restore the `throw`, confirm the new test fails,
  restore the fix. Quote the failure text.
- `pnpm -C packages/core test` — **413 passing** before your change; must be
  greater, zero failures.
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` exits 0.

## Constraints

- Do **not** run any live smoke (`smoke:*`) — they cost provider credits and the
  manager runs them. Do not fake output, do not list them in `claims`.
- Do not touch `MEDIA_KINDS`, the media drain loop, or `examples/`.
- Do not change `mainCapacity`'s default.

## DISCLOSURE REQUIREMENT

If you change behaviour this brief did not ask for, or add something you cannot
cover with a test, say so under `undisclosed_changes`. A silent untested
adaptation is a failed dispatch even with a green suite. Report the
`pipeline-bus.test.ts` assertion change there too if you make one.

## Result contract

Write `runs/result-main-overflow.json`:

```json
{
  "task": "Make Route.Main overflow degrade instead of throwing",
  "status": "done | blocked",
  "claims": [{"cmd": "<command>", "exit": 0, "note": "<what it proves>"}],
  "files_touched": ["..."],
  "sabotage": "<what you broke, the failure text, that you restored it>",
  "undisclosed_changes": "<anything beyond the brief, or 'none'>"
}
```

Then write `done` to `runs/result-main-overflow.done`.
