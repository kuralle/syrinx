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

## Why turn-taking is NOT a clean comparison here (reported straight, /diagnose'd 2026-07-11)

The turn-taking numbers must not be read as an equivalence claim. A follow-up diagnosis (deterministic
replay of the captured raw timestamps, `runs/thesis-*.txt`) **corrected two mechanisms I first published
here** — the record of that correction is kept deliberately.

1. **The native arm's EVA score is a fresh-session artifact.** ✅ *proven.* Native realtime cannot run
   multiple turns in one session under this driver (bridge bug below), so each turn is a fresh session.
   The EVA cross-turn inter-turn gap then compares independent sessions' wall-clocks against a *projected*
   playout-end and produces nonsense: `gap[turn-3] = uStart(57230) − prev.aEnd(63247) = −6017 ms` — turn 3
   "begins" before turn 2's assistant audio "ends", which is impossible in one real conversation. That
   −6017 (gap<0 → +50, gap<200 → +30) is the entire +80 penalty → score 20. The score is meaningless.

2. **Cascade's ~5 s is real LLM+tool latency, NOT an STT timeout.** ❌ *my first claim (the 4500 ms
   `sttForceFinalizeTimeoutMs`) was wrong.* Decomposing the cascade turn (`audio→eos→firstAgent→firstAudio`,
   n=3): endpoint fires at **~1.2–1.8 s** (the 4500 ms force-finalize never triggers — the natural endpoint
   wins), **LLM + 2 tool round-trips = ~2.6–4.3 s (dominant)**, TTS TTFB ~0.6–0.9 s; total ~4.7–6.4 s. So
   cascade's latency **is** a real v2v for this tool-calling agent — it just pays for the serial
   STT→LLM(+tools)→TTS pipeline. (The EVA score gives slow-cascade 100 and fast-native 20, i.e. it does not
   track the real latency gap — another reason the *score* is the wrong instrument.)

3. **The raw latencies aren't apples-to-apples either — filler vs answer.** Native's fast ~1.3 s
   "firstAudio" is a **pre-tool filler** (*"Are you still there?"* — audio events precede `tool_call` in the
   adapter trace), not the grounded answer; cascade's ~5 s firstAudio is the grounded answer. So
   native-1.3 s vs cascade-5 s is *time-to-filler* vs *time-to-grounded-answer*, not a like-for-like
   response latency.

**Net:** under fixed-fixture + trailing-silence driving, neither the EVA turn-taking *score* (native
fresh-session artifact) nor the raw response *latency* (filler-vs-answer; and cascade's real cost is LLM+
tools, not turn-taking) is a fair intrinsic turn-taking comparison. A faithful comparison needs a **live
full-duplex examiner bot** (bot-to-bot, natural barge-in + pause dynamics, semantically-aligned response
points), not recorded fixtures + silence. This harness proves task-success parity and correctly scopes
what a real turn-taking proof requires.

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
