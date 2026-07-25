# LDT-6 — event log panel, implementation notes

## Load-bearing decisions

**Per-frame noise is a set, not one type.** The brief names `tts_chunk`; hiding only
that still leaves `stt_chunk` (one per interim), `playout_progress` and `ping`
drowning the panel. `PER_FRAME` maps each to a plain-language noun so the count
line reads "142 audio frames, 30 partial transcripts hidden" and never prints a
packet name — design rule 1. All four are hidden by default.

**Selecting a per-frame type by name overrides the hide.** Otherwise filtering to
`tts_chunk` yields an empty panel — a trap that reads as a bug. Covered by a test.

**Native `<select>` rather than the Radix `Select` used by `ConnectionBar`.** Radix's
select is not driveable in jsdom without pointer-event shims, and both filters are
required behaviour that must be test-covered rather than eyeballed. The two controls
are styled to match the Radix trigger. This is the one place the panel departs from
the sibling idiom, and it is a testability decision, not a preference.

**Type filter survives a reconnect; the turn filter does not.** The task's
done-condition is "filter state survives a reconnect". A `turnId` is session-scoped,
so retaining one across a reconnect filters the new session down to nothing forever
— the selection is dropped when the id is absent from the record. Types are
session-independent and persist, including when the fresh record has no events of
that type yet (the option is retained so the filter stays visible and reversible).

**Dropped-entry line.** `SessionRecord` counts evicted turns and events precisely so
they are "surfaced, never silent", and no panel was surfacing them. The raw stream is
the honest place for it: three lines, one testid.

## Scope

The board task's action item "click an event to highlight its turn in the timeline
and transcript, and vice versa" is **not** implemented. The dispatch brief's Build
section scopes this to `EventLog.tsx` + its test + the `SessionView` mount; the
cross-highlight is a lift-state-up change across `Timeline`, `TranscriptPanel` and
`SessionView`, and belongs to whichever task owns that shared selection. Everything
else in the task (stream, both filters, per-frame hiding behind a count, expandable
payload, copy turn as JSON) is built and tested.

## Verification

Four gate commands, all exit 0 (see `runs/result-ldt-6.json`). 11 new component
tests, every one folding a real `SessionRecord` through `buildSessionRecord` — no
hand-built record literals. Unknown types are covered by a `cf_agent_identity` /
`cf_agent_mcp_servers` test. Not verified live in a browser: the panel has not been
driven against a running backend in this dispatch.

A concurrent dispatch (the transcript-fidelity task, which reshaped `TranscriptPanel`
from a `state` prop to `record` and deleted `lib/transcript.test.tsx`) held the shared
gate red mid-run. Its breakage was left alone rather than patched — racing another
agent's in-flight edit fixes nothing and risks double-applying. The claimed gate is
the run made after that tree settled; `EventLog.test.tsx` was 11/11 green in every
run throughout, including while the shared gate was red.
