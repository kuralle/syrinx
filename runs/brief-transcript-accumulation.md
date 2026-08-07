# Accumulate a turn's user transcript across STT finals

Context: http://127.0.0.1:7526/api/v1/share/plandesk_share_K6xrtltisSyDeXmA5VsHD6JhcsVJgSQFaTJZbA4Ft78.md

Read the Context link first. It is the live task, including a comment titled
"Root cause located" that names the exact call sites. Do not re-derive the cause.

Repo: /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx

## The bar

The system assumes **one STT final per turn**. The provider emits one final per
endpointed segment, so a long utterance arrives as several finals under one
`contextId`. Every consumer keeps the last and discards the rest. A live
two-sentence utterance was recorded as the single word `"payment."`

A turn's user transcript is **the concatenation of every final in that turn, plus
the live interim**. This is already how the assistant side works
(`appendAssistantTranscript`). Make the user side agree.

## The red gate — already written, currently failing

`packages/core/src/iu-transcript-accumulation.test.ts` exists and is **red**:

```
FAIL  keeps every final in a turn, not only the last
AssertionError: expected 'because that changes how I plan my pa…' to contain 'lab fee'
```

The second test in that file (`still replaces interim text rather than
accumulating it`) **passes today and must keep passing**. It exists to stop the
naive fix of turning every write into an append. Do not weaken, rename, skip or
delete either test.

## The ground — three call sites, all verified

**1. `packages/core/src/iu-segmentation.ts` — the core defect.**

`recordUserTranscript` overwrites:

```ts
this.transcriptTextByKey.set(iuStorageKey(id), text);
```

while `appendAssistantTranscript` directly below it accumulates. There is exactly
one user IU per turn — `userIuId(contextId)` returns
`{ contextId, iuId: contextId, epoch }` — so all finals in a turn share one
storage key and the last write wins.

**2. `packages/core/src/voice-agent-session.ts` — three callers, different needs.**

| line | handler | correct behaviour |
| --- | --- | --- |
| ~988 | `handleSttInterim` | **replace** the interim — successive revisions of one hypothesis |
| ~1022 | `handleSttResult` | **append** — a completed segment, and clear the interim |
| ~1346 | `handleTurnComplete` | final text for the turn; must not discard earlier finals |

**3. `packages/aisdk/src/index.ts` — the history path has the same defect.**

`processTurn` does `this.turnUserText.set(contextId, userText)` (last-wins), and
`rememberTurn` pushes that value into `this.history`. So conversation history
truncates by the same rule, on both the `sessionOwnsSegmentation` branch and the
legacy branch. Fix both, or route both through one accumulating source.

## Requirements

- REQ-1: A turn with N finals yields a user transcript containing all N, in
  order, separated by a single space. No duplicated text when a final repeats an
  interim's content verbatim.
- REQ-2: Interims still replace. A turn's transcript never contains a superseded
  interim.
- REQ-3: `packages/aisdk` history records the accumulated turn text, not the last
  final.
- REQ-4: Backchannel turns keep their current behaviour (`isBackchannel` early
  return) — unchanged.
- REQ-5: Turn boundaries reset accumulation. Turn N+1 must not inherit turn N's
  text. `resetContext` / epoch changes must clear the accumulated buffer.

## Definition of done

- `packages/core/src/iu-transcript-accumulation.test.ts` passes in full.
- You add a session-level test: drive `stt.interim` → `stt.result` →
  `stt.interim` → `stt.result` on one `contextId` through `VoiceAgentSession` and
  assert `user_input_final` / the committed transcript view spans both finals.
- You add an `aisdk` test asserting history holds the accumulated text.
- You add a test for REQ-5 (no bleed across turns).
- `pnpm -C packages/core test` — right now this is **`1 failed | 409 passed (410)`**;
  the 1 failure is the red gate. After your change: **zero failures**, and the
  passing count must be greater than 410 because you are adding tests.
- `pnpm -C packages/aisdk test` — **55 passing before**, must be greater after.
- `pnpm -r typecheck` exits 0.
- **Sabotage check, and report it:** after it is green, restore the overwrite in
  `recordUserTranscript`, confirm the red-gate test fails again, then restore
  your fix. State the observed failure text in your result.

## Constraints

- Do **not** run any live-provider smoke (`smoke:*`). Those cost credits and the
  manager runs them. Do not fake their output and do not put them in `claims`.
- Do not touch `packages/core/src/pipeline-bus.ts` or the media-lane tests.
- Do not change `sttForceFinalizeTimeoutMs` — the watchdog was investigated and
  ruled out (`stt.force_finalized` fired 0 times live).
- Do not "fix" the smoke harness in `examples/` — a separate task owns the
  measurement side.

## DISCLOSURE REQUIREMENT

If you change any behaviour this brief did not ask for, or you add a fix you
cannot cover with a test, say so explicitly in your result under a heading
`Undisclosed changes`. A silent untested adaptation is treated as a failed
dispatch even when the suite is green. If you cannot satisfy a requirement, write
`runs/blocked-transcript-accumulation.md` and stop rather than working around it.

## Result contract

Write `runs/result-transcript-accumulation.json`:

```json
{
  "task": "Accumulate a turn's user transcript across STT finals",
  "status": "done | blocked",
  "claims": [
    {"cmd": "<command>", "exit": 0, "note": "<what it proves>"}
  ],
  "files_touched": ["..."],
  "sabotage": "<what you broke, what failed, that you restored it>",
  "undisclosed_changes": "<anything beyond the brief, or 'none'>"
}
```

Then write the single word `done` to `runs/result-transcript-accumulation.done`.
