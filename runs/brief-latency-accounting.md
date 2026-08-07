# Fix the interactive smoke's latency accounting under speculative generation

Context: http://127.0.0.1:7526/api/v1/share/plandesk_share_K6xrtltisSyDeXmA5VsHD6JhcsVJgSQFaTJZbA4Ft78.md

That link is a *different* task (the transcript fix, now done) — read it only for
background on why this matters. **This brief is the contract.**

Repo: /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
File: `examples/02-hello-voice-headless/scripts/run-websocket-university-interactive.ts`

## The bar

The instrument reports numbers that are not measurements. On three live runs
today it emitted `avgLlmTimeToFirstText` of **−235, −338, −351 ms**. A negative
time-to-first-text is not a latency. Separately, it **drops the fastest turns**
from its percentile sample, so a change that makes the engine answer sooner makes
the reported figures look worse.

This already caused a false result: a "median improved 2075 → 643 ms" was
reported, committed, and had to be reverted.

## Two defects, both verified in the source

**1. The best turns are excluded from the percentiles.**

`finalizeTurnMetrics` computes `firstAudioAtMs - speechEndedAtMs`; when
non-positive it sets `metricsE2eMs = 0` and counts an exclusion.
`positiveVoiceToVoiceMs` then filters `> 0`. A turn answered *before the user
stopped speaking* — the best possible outcome — is removed rather than recorded.
With 3 turns and 1 excluded the sample is **n=2**, so P95 = P99 = max = one
observation presented as a tail.

**2. The aggregates contradict the per-turn fields.**

`buildTurnLatencyMs` gates negatives out per turn (`if (llmTimeToFirstText >= 0)`),
so a speculative turn has no `llmTimeToFirstText` at all. But the aggregate block
averages the **raw signed** values across every turn. On one run the per-turn view
says "not measured" and the aggregate says `−336 ms`. Same for
`avgTtsTimeToFirstAudio`.

## Requirements

- REQ-1: A turn answering before speech end is recorded as a **speculative lead**,
  not discarded and not clamped to 0. Clamping hides a win as a zero.
- REQ-2: Two separate named series, so neither hides the other:
  `voiceToVoiceP50Ms` over turns answering *after* speech end, and
  `speculativeLeadP50Ms` + `speculativeTurnCount` over the rest. Both denominators
  appear in `diagnostics`.
- REQ-3: Every `avg*` averages only values actually recorded per turn, over that
  count, and carries a matching `*SampleCount`. **No aggregate may ever be
  negative.**
- REQ-4: `percentile` returns `null` below a stated minimum sample size (use 3),
  plus a diagnostic naming the size. Never index a 2-element array and call it P95.
- REQ-5: The emitted `metrics.json` and baseline JSON contain **no negative
  value** anywhere.

## Approach — extract, then test

The metric functions are currently unexported locals in a `tsx` script, so they
cannot be tested. First move the **pure** ones into a new module:

`examples/02-hello-voice-headless/scripts/interactive-latency-metrics.ts`

exporting `average`, `percentile`, `finalizeTurnMetrics`, the two new selectors
(`respondedAfterSpeechEndMs`, `speculativeLeadMs`), `buildTurnLatencyMs`, and the
aggregate builder. Import them back into the runner so behaviour is unchanged
apart from this fix. Keep the `InteractiveTurnCapture` type where it is or move it
alongside — your call, but do not duplicate it.

This is a mechanical extraction. Do not restructure the socket/run loop.

## Definition of done

- New test file `examples/02-hello-voice-headless/test/interactive-latency-metrics.test.ts`
  driving a synthetic turn set of exactly three turns:
  - one answering **before** speech end (negative raw v2v),
  - one normal turn,
  - one slow cold-start turn,

  asserting: the speculative turn appears in the lead series and **not** in the
  v2v series; both counts are reported; no aggregate is negative; and a
  2-sample percentile returns `null`.
- **Sabotage, and report it:** restore the `> 0` filter in
  `positiveVoiceToVoiceMs`, confirm the new test fails, restore your fix. Quote
  the failure text in your result.
- `pnpm -C examples/02-hello-voice-headless test` — zero failures, count greater
  than before.
- `pnpm -C examples/02-hello-voice-headless typecheck` exits 0.
- `pnpm -r typecheck` exits 0.

## Constraints

- Do **not** run any live smoke (`smoke:*`). They cost provider credits and the
  manager runs them. Do not fake their output, do not put them in `claims`.
- Do **not** regenerate `websocket-university-interactive-baseline.json`. The
  manager decides when to re-baseline; a stray regeneration overwrites it in place
  and destroys the committed reference.
- Do not touch `runQualityGate`'s fixture-term check or the
  `sttFinal < speechEnded` diagnostic — both were just settled deliberately in
  commit `ecce9bc`.
- Do not touch `packages/`.

## DISCLOSURE REQUIREMENT

If you change behaviour this brief did not ask for, or add something you cannot
cover with a test, say so under a heading `Undisclosed changes`. A silent
untested adaptation is a failed dispatch even with a green suite. If a
requirement cannot be met, write `runs/blocked-latency-accounting.md` and stop
rather than working around it.

## Result contract

Write `runs/result-latency-accounting.json`:

```json
{
  "task": "Fix the interactive smoke's latency accounting",
  "status": "done | blocked",
  "claims": [{"cmd": "<command>", "exit": 0, "note": "<what it proves>"}],
  "files_touched": ["..."],
  "sabotage": "<what you broke, the failure text, that you restored it>",
  "undisclosed_changes": "<anything beyond the brief, or 'none'>"
}
```

Then write `done` to `runs/result-latency-accounting.done`.
