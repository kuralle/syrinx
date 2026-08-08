# Heard-prefix truncation must degrade honestly without word timings

Repo: /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx

## The bar

On barge-in the assistant turn is committed to what the caller **actually
heard**, so the reasoner does not believe it said things the caller never got.
That works only when `tts.word_timestamps` are available. When they are not,
`computeHeardAssistantPrefix` in `packages/core/src/voice-agent-session.ts`
returns the **entire emitted text**:

```ts
if (words && words.length > 0 && playedOutMs !== undefined && playedOutMs > 0) {
  return words.filter((word) => word.endMs <= playedOutMs).map((word) => word.word).join(" ");
}
return (this.ttsTextBuffers.get(contextId)?.emitted ?? "").trim();   // <-- the whole reply
```

That is exactly the pre-fix behaviour the truncation exists to prevent, and it is
silent — the suite is green either way.

## Provider survey — already done, do not re-derive

I enumerated every package that emits `tts.audio` and checked which emits
`tts.word_timestamps`:

| provider | word timings |
| --- | --- |
| **cartesia** | **yes** (`packages/cartesia/src/index.ts`) |
| deepgram | no |
| openai-tts | no |
| gemini | no |
| elevenlabs | no |
| realtime fronts (Gemini Live audio) | no |
| tts-core, cli, test helpers | no |

**Cartesia is the only provider with exact truncation.** Every other path takes
the full-text fallback today. This is broader than "some providers" — it is the
default.

## Requirements

- REQ-1: With no word timings, the heard prefix must **never** be the full
  emitted text. Returning everything is the bug.
- REQ-2: Fall back to a `playedMs`-proportional character estimate: estimate the
  characters heard from elapsed playout, clamp to `[0, text.length]`, and cut at
  a **word boundary** so the transcript is not left mid-word. Justify the rate
  you choose in a comment (English speech is roughly 150 wpm ≈ 15 chars/s; derive
  it however you like, but state the basis).
- REQ-3: Emit an observable signal when the estimate is used — a
  `metric.conversation` on `Route.Background`, consistent with existing metric
  emission — so an approximate truncation is distinguishable from an exact one.
  It must **not** fire when timings were available.
- REQ-4: State the degradation in the doc comment on
  `setAssistantHeardPrefix` (`packages/core/src/iu-segmentation.ts`) and on
  `computeHeardAssistantPrefix`, including which providers are exact. Put the
  table above in one of them so the next reader does not re-derive it.
- REQ-5: The exact path is unchanged when timings exist.

## Definition of done

- Test: barge-in **with** word timings → exact prefix, no estimate signal.
- Test: barge-in **without** word timings → a prefix strictly shorter than the
  full emitted text for a partial playout, ending on a word boundary, and the
  estimate signal fired.
- Test: playout of 0 ms without timings → empty prefix, not the full text.
- Test: playout exceeding the estimated length clamps to the full text without
  overrunning.
- **Sabotage, and report it:** make the fallback return the full text again,
  confirm the no-timings test fails, restore. Quote the failure text.
- `pnpm -C packages/core test` — **415 passing** before your change; must be
  greater, zero failures.
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` — run it and report the exit code. Two tests are known to flake
  under load (`packages/deepgram` PCM frame boundary, `packages/server-websocket`
  SmartPBX DTMF, both `Test timed out in 5000ms`). If either appears, say so and
  re-run; do not claim it as your failure and do not "fix" it here.

## Constraints

- Do not run any live smoke (`smoke:*`) — they cost credits and the manager runs
  them.
- Do not add word-timestamp emission to any provider. That is a much larger piece
  of work and is not this task; this task is only about degrading honestly when
  they are absent.
- Do not change the exact path's behaviour.

## DISCLOSURE REQUIREMENT

If you change behaviour this brief did not ask for, or add something you cannot
cover with a test, say so under `undisclosed_changes`. A silent untested
adaptation is a failed dispatch even with a green suite.

## Result contract

Write `runs/result-heard-prefix.json`:

```json
{
  "task": "Heard-prefix truncation degrades honestly without word timings",
  "status": "done | blocked",
  "claims": [{"cmd": "<command>", "exit": 0, "note": "<what it proves>"}],
  "files_touched": ["..."],
  "fallback": "<the estimate rule and the basis for the rate>",
  "signal": "<the metric name emitted when estimating>",
  "sabotage": "<what you broke, the failure text, that you restored it>",
  "undisclosed_changes": "<anything beyond the brief, or 'none'>"
}
```

Then write `done` to `runs/result-heard-prefix.done`.
