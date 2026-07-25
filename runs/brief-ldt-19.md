# Brief — LDT-19: expose the endpointing decision on the wire

Repo: `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`
Work on `main`. **Commit nothing** — leave changes in the working tree.

You are the only worker in this repo. No other agent is running.

## Why this matters

The turn timeline can show *when* a turn ended but not *which owner decided* or *why*.
That is the single richest addition for turn-taking debugging: it turns "it cut me off"
from a feeling into a named cause.

## The carrier decision is ALREADY MADE — do not re-open it

**Extend the existing `metrics` message.** Not a new `SyrinxStudioMessage` variant, not a
separate debug channel.

Reasons, so you can check your work against them:
- `eouBudgetMs` — the endpointing *timing* breakdown (`vadStopHangoverMs`,
  `sttFinalDelayMs`, `endpointDelayMs`, `totalMs`) — already lives in `metrics`. The
  endpointing *decision* belongs beside its own timing, not in a second message.
- `metrics` now emits from BOTH runtimes (Node and Workers/DO) through one shared
  builder, so "emit from both" is free if you put it there. It was not free last week.
- **Additive only.** `SyrinxStudioMessage` has third-party consumers via the published
  `@kuralle-syrinx/browser-client`. Add optional fields; change no existing field's name,
  type, or meaning.

## Ground truth — call sites, verified

**The owner type** — `packages/core/src/plugin-contract.ts:18`:
```ts
export type EndpointingOwner = "provider_stt" | "smart_turn";
```
`VoiceAgentSession` additionally accepts `"timer"` (`voice-agent-session.ts:185`, `:409`,
validated at `:423`). Whatever you emit must cover all three plus the text case below.

**The packet that carries a completed turn** — `packages/core/src/packets.ts:223`:
```ts
export interface EndOfSpeechPacket extends VoicePacket {
  readonly kind: "eos.turn_complete";
  readonly text: string;
  readonly transcripts: readonly SttResultPacket[];
}
```
It has no owner and no reason. That is the gap.

**Two emission sites, and they are NOT the same event:**
1. `packages/core/src/interaction-coordinator.ts:183` — the real endpointing decision.
   Inside `tryScheduleTurnComplete`, the policy has committed and `pending` carries
   `waitMs` and `confidence` (see `confidenceToWaitMs`). This is where owner/reason is
   genuinely known.
2. `packages/core/src/voice-agent-session.ts:878` — `handleUserText`. A TYPED turn pushes
   an immediate `eos.turn_complete`. Nothing endpointed it; no one decided you stopped
   talking, because you typed. **Do not label this with a speech owner.** A typed turn
   must be distinguishable, or the timeline will claim an endpointer fired when none did.

**Force-finalize** exists (`sttForceFinalizeTimeoutMs`, defaulted in `run-one-turn.ts` to
3500) — find where it fires and mark turns it produced. A turn the STT was *forced* to
finalize is a different diagnosis from one that ended naturally, and that difference is
most of this task's value.

**The metrics builder** — `packages/server-websocket/src/turn-metrics.ts`,
`buildBrowserMetricsMessage`. Note `positiveDelta` (line ~48) returns `undefined` when a
mark was never measured, so unmeasured marks are OMITTED rather than sent as zero.
**Preserve that discipline exactly** for anything you add: absent must mean absent. A
zero in a debugging surface reads as a measurement, which is a lie.

**The consumer** — `packages/browser-client/src/session-record.ts` (`SessionConfig` already
has an optional `endpointingOwner`), `packages/browser-client/src/turn-timeline.ts`, and
`apps/studio/src/components/Timeline.tsx`.

## Build

1. Carry the decision on `EndOfSpeechPacket` — optional fields, populated at BOTH sites,
   with the typed-turn case honestly distinguished from a speech endpointer.
2. Thread it into `metrics` via the shared builder, so both runtimes emit it.
3. Surface it on the `SessionRecord` turn.
4. Render it on the timeline as a marker naming the owner and the reason.

## Hard requirements

- **Plain language in the UI.** Never a packet or message name in user-facing text — no
  `eos.turn_complete`, `provider_stt` raw, `stt.result`. Say what happened in words a
  person reads. Internal type values may use the existing identifiers.
- **Never fabricate, never hide.** If the owner is genuinely unknown for a turn, omit it
  and let the UI say so. Equally, do not drop a field the backend did measure.
- Root-cause fixes only. No `@ts-ignore`, no `as any`, no widening a type to dodge an error.
- No new dependencies.
- Do not touch `apps/docs/`, `examples/`, or anything telephony.

## Gate — all must exit 0

```
pnpm -C packages/core test
pnpm -C packages/server-websocket test
pnpm -C packages/browser-client test
pnpm -C apps/studio test
pnpm -C apps/studio build
pnpm -r typecheck
```

Cover explicitly: a `provider_stt` turn, a `smart_turn` turn, a force-finalized turn, a
TYPED turn (must not claim an endpointer), and a turn where the owner is unknown (field
omitted, UI says so rather than guessing). Tests fold a real `SessionRecord` via
`buildSessionRecord(...)` — see `apps/studio/src/components/Timeline.test.tsx`.

## Command efficiency

NEVER re-run an expensive or slow command (test suites, builds, large greps) just to
change a pipe, filter, `grep`, `tail`, or `head`. Run it ONCE, capture the FULL output to
a uniquely-named temp file via `mktemp` (`log=$(mktemp); cmd > "$log" 2>&1`), then
grep/inspect `"$log"` as many times as needed. Always use `mktemp`, never a fixed path.

## Result contract

Write `runs/result-ldt-19.json`:

```json
{ "status": "done | blocked",
  "claims": [{ "command": "<exact command>", "exit_code": 0 }],
  "notes": "<what you could not verify, and why>",
  "question": "<only when blocked>" }
```

`status: done` with no claims is invalid. **Claims are re-run and the diff is read.** A
claim whose re-run differs is a false claim. Never claim a command you did not personally
run to completion. An honest gap in `notes` is useful; a false claim is not.
