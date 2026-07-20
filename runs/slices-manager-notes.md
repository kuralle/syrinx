# Manager notes — the slice wave (2026-07-19/20)

Full record of what shipped, what was delegated, what came back wrong, and what is
deliberately still open. Detailed evidence lives in
[`phase0-spike-implementation-notes.md`](phase0-spike-implementation-notes.md) (A1–A13).

## Shipped

| Slice | Covers | Worker | Manager intervention |
|---|---|---|---|
| 1 + 1b | turn_latency decomposition, speculative counters (#33) | codex luna | fixed contextId carry-forward; my first fix was wrong too |
| 1c | native anchor — the blocker (#33) | codex luna | live-proved it myself; worker's sandbox had no provider DNS |
| 1d | native breakdown + LLM pass count (#33) | codex luna | **fixed a metric selection bias the worker introduced** |
| 2 | MetricsExporter export + cardinality | codex luna | verified tag contract; none needed |
| 3 | Gemini adapter surface (#28 #29 #31 #32) | codex luna | **reverted a silent regression + the test pinning it** |
| 4 | reasoner→client seam (#30) | codex luna | verified; issue premise was wrong, fix was right |
| 5 | grounded tool cue | — | **closed without building — obviated by slice 8** |
| 6 | preamble / speculative / hedging experiments | manager | all three run live |
| 7 | CF DO migration docs (#20) | codex luna | none |
| 8 | adopt preamble prompt as default | manager | — |

Every original GitHub issue is closed: #20, #28, #29, #30, #31, #32. #33 was filed by
this wave and is substantially complete.

## The three findings that changed what we believe

**1. A prompt beat every code lever.** Asking the model for one grounded sentence before
the tool call cut TTFA from ~3964 ms to ~1568 ms (n=2/arm), tool still called, answer
still grounded. Larger than anything in the reasoner-latency RFC, and it is a prompt edit.
Honest framing, carried in the code comment and the budget doc: it reduces time-to-first-
*useful*-audio, not time-to-answer.

**2. Speculative start is net-harmful on a per-interim endpointer.** 13 started, 13
discarded, 0 promoted, no latency gain. Promotion needs `draft.userText === eos.text`
exactly; Flux guarantees that match, `PipecatEOSPlugin` fires on every interim so it
almost never holds. `latency-budget.md` claimed Lever D "is what actually gets under 1s" —
true on Flux only. Corrected at both the option and the budget.

**3. Hedging was not adopted.** Median ttfa 1484 → 1336 ms looks good until you notice the
ranges overlap and n=3 gives zero tail visibility — which is the only thing hedging was
built for. Recommending 2x LLM spend on that would have been an unearned claim. Wiring is
in place (`hedgeAfterMs`, `SYRINX_SPIKE_HEDGE_MS`) so an n>=20 tail-shaped run is cheap.

## Where delegation failed, and the pattern

Four of five delegated slices needed manager correction, and none of it was visible in the
worker reports:

- **Slice 3** made Gemini input transcription default OFF, which would have silently killed
  all user-side text (`realtime-bridge.ts` turns `role:"user"` transcripts into `stt.result`)
  — **and wrote a test asserting the broken behavior**. A green suite would have certified it.
- **Slice 1d** deferred `turn_latency` emission to `tts.end` to catch post-tool passes, which
  made **barged turns emit nothing**. Barge-in correlates with slow turns, so that biased the
  sample toward fast ones — the worst turns vanishing from the metric meant to surface them.
- **Slice 1** passed 294 tests on a feature that had never worked on native.
- **Slice 4** was correct, but built on an issue premise that was factually wrong
  (`onDelegateResult` and `connection` already existed); only reading HEAD established that.

Also: **no worker could reach `gh` or, in later runs, provider DNS.** Every one worked purely
from its brief and honestly reported it could not verify live. That honesty is why the
briefs had to carry the whole spec — a thin brief would have produced confident, wrong work.

## Green tests certified broken behavior three times

The through-line of the wave. Root cause for the instrument: **~203 hardcoded `contextId`
literals in `voice-agent-session.test.ts` against 1 test that rotates.** The bugs here are
all about identity changing mid-turn; a test author picks one id and moves on, so the suite
is structurally blind to the entire class.

Mitigation shipped: `pnpm smoke:turn-latency` — a live gate over both fronts that fails if
the event does not fire, fires without an anchor, or reports a total with zero stages (the
"instrument on but blind" state, which looks healthy on a dashboard). It is the check that
would have made the native bug unshippable.

**Not fixed:** the 203 literals. The gate catches the symptom at release; it does not stop
the next test from being written blind. A rotation-by-default test helper is the structural
answer and was not built.

## Open, and deliberately so

- **Usage metering does not exist.** Zero token/cost/billing accounting anywhere. This is the
  single largest blocker to a customer-billed deployment. Released to `todo` on the board.
- **No real exporter backend.** The seam and the values now exist and are cardinality-clean;
  Workers Analytics Engine / OTLP is still unwritten, so nothing leaves the process by default.
- **Denoise seam is declared and empty** — zero producers, zero consumers. False barge-in under
  noise has a 15 s turn-cap backstop, not a fix.
- **Hedging** needs the n>=20 tail run before any adoption call.
- **Native `eouDelayMs`/`textAggregationMs`/`ttsTtfbMs`** are `n/a` by documented design, not
  by omission — native endpointing is provider-owned and the aggregation events on the
  `idle-*` context belong to the prior turn. Fabricating them would have been worse.
