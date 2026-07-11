# Interaction thesis — bounded live results (cascade+rules vs native-realtime)

Status: Published — honest, bounded. 2026-07-11.

Proof gate for the decoupled-orchestration thesis: does the shipped cascade front match native
realtime on **turn-taking** without a **task-success** regression? Per the C6 finding (VAP resolved
to *properly dormant* — cheap Silero+SmartTurn beat Kyoto+STT, `docs/c6-vap-eval-results.md`), the
meaningful shipped-product comparison is **`cascade+rules` vs `native-realtime`**, not the VAP crown
cell. This is the bounded run the user scoped.

Harness: `examples/02-hello-voice-headless/scripts/run-interaction-thesis-matrix.ts`
(`smoke:interaction-thesis-matrix`). Both arms drive the **same** first 3 `GEMINI_UNIVERSITY_FIXTURES`
through the **same** capture (`captureTurn`) and **same** scoring (`evaluateEvaExaminer` +
tool-called+grounded-reply task-success). Only the session front differs. Live: OpenAI Realtime +
Deepgram + Cartesia, 2026-07-11 (raw: `runs/thesis-matrix-*.txt`, `runs/thesis-matrix-result.json`).

## Live matrix (3 university turns each)

| config | turn-taking score | avg response latency | task-success |
|---|---|---|---|
| cascade+rules | 100 | ~4.5–5.0 s | **1.00** |
| native-realtime | 0–20 | ~1.2–1.6 s | **1.00** |

## The one trustworthy result — task-success parity

**No task-success regression: cascade+rules 1.00 vs native-realtime 1.00.** All 3 turns, both fronts,
called a grounding tool and produced a non-empty grounded reply. This half of the thesis holds.

## Why turn-taking is NOT a clean comparison here (reported straight)

The turn-taking numbers above are **confounded** and must not be read as an equivalence claim. Two
independent reasons, both evidenced from the live EVA timelines (`SYRINX_THESIS_DBG=1`):

1. **Cascade latency is dominated by an endpoint-detection timeout, not intrinsic turn-taking.** The
   interactive profile force-finalizes STT after **4500 ms** (`sttForceFinalizeTimeoutMs`). Driven with
   fixed fixture audio + trailing silence, cascade's per-turn response latency is ~4.1–4.9 s — the 4.5 s
   timeout, not a real conversational v2v. (In a live call, a natural pause + VAD finalizes far sooner.)
   Cascade scores 100 only because ~4.5 s < the 8 s EVA penalty ceiling.

2. **The native arm's turn-taking score is a fresh-session artifact.** Native realtime cannot run
   multiple turns in one session under this driver (see the bridge bug below), so each turn uses a
   fresh session. The EVA scorer's cross-turn inter-turn gap then compares independent sessions'
   wall-clocks against a *projected* playout-end, producing nonsense (e.g. turn-3 `interGap = −6017 ms`,
   which trips the gap<0 penalty → score 20/0). The negative gap is meaningless, not a real overlap.

**Net:** under fixed-fixture + trailing-silence driving, "turn-taking timing" is governed by each
front's endpoint-detection config and by session lifecycle — not by intrinsic turn-taking quality. A
faithful turn-taking comparison needs a **live full-duplex examiner bot** (bot-to-bot, natural barge-in
and pause dynamics), not recorded fixtures + silence. This harness proves task-success parity and
correctly scopes what a real turn-taking proof requires.

## Two real issues surfaced by the live run

- **Multi-turn realtime-bridge cancel race (bridge robustness bug).** Running >1 turn in one native
  session aborts: with `server_vad`, the next turn's `speech_started` makes the bridge issue a barge-in
  cancel, but the prior response has already completed, so the OpenAI adapter throws
  `internal_fault: Cancellation failed: no active response found`. A barge-in cancel with no active
  response should be a no-op. Worked around here with fresh-session-per-turn; tracked for a bridge fix.
- **Turn-taking is not measurable with fixed-fixture driving** (above) — a harness/methodology limit,
  captured so the next attempt builds the live examiner instead of re-running fixtures.

## Behavioural note

Every native-realtime reply opened with *"Are you still there?"* — `server_vad` (500 ms) is impatient
on ~3 s fixtures, prompting during internal pauses. Anecdotal (n=3, one domain), but consistent with
why Syrinx-owned endpointing / half-cascade turn control is worth having; not a measured claim.

## Verdict

- **Task-success parity: PROVEN** (1.00 vs 1.00, no regression).
- **Turn-taking equivalence: NOT established** — confounded by endpoint config + session lifecycle
  under fixed-fixture driving. Follow-up: live full-duplex examiner bot; fix the multi-turn bridge
  cancel race. The full thesis ("matches on turn-taking AND no task-success regression") is therefore
  **partially proven** (task-success half only) by this bounded harness.
