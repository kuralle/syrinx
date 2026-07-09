# C6 — eval harness design (manager-owned)

RFC §9.4 proof gate: a one-command config sweep producing a **turn-taking × task-success** metrics table
across the architecture configs, so the decoupled thesis is declared proven only when `cascade+VAP+rich-seam`
matches `native-realtime` on turn-taking **without** a task-success regression.

## Premise update (verify-before-build — the turn-taking half already exists)

The RFC frames C6 as "build an eval harness." **Half of it already ships** (VE-05, 2026-05-31):
- `examples/02-hello-voice-headless/scripts/eva-evaluator.ts` — **"EVA-X turn-taking-timing + Full-Duplex-Bench
  overlap scoring"**: `turnTakingTimingScore`, `overlapScore`, `avgResponseLatencyMs`, `maxResponseLatencyMs`,
  `minInterTurnGapMs`, `overlapPercent`, per `clean|noise|accent` perturbation, with gate modes + baselines
  (`test/performance/eva-bench-examiner-baseline.json`). This IS the Full-Duplex-Bench-style turn-taking metric.
- `scripts/run-eva-bench-examiner-smoke.ts` — drives a bot-to-bot examiner conversation and scores it
  (`smoke:eva-bench-examiner`).
- `scripts/bench-reasoner-latency.ts` — the **config-sweep** pattern (bench each config, percentiles, table).
- `turn_latency` session event — the TTFA decomposition per turn.

So C6's net-new work is **(A) a config-sweep driver** over the existing examiner across interaction configs,
and **(B) a task-success metric** (voice τ-bench — the genuinely new half).

## Scope (this build)

**A — config sweep (reuse eva-evaluator):** run the examiner scenario across interaction configs and collect
the existing turn-taking scores per config into one table. Configs:
- `cascade+rules` (today's `RuleBasedInteractionPolicy`)
- `cascade+VAP` (`VapInteractionPolicy` from C5 — the injection point is the session/withVoice policy
  selection; **depends on C5 landing**)
- `cascade+VAP+rich-seam` (VAP consuming C4 `wordTimings`)
- `native-realtime` / `realtime+delegate` (existing realtime path) — the live baselines
Reuse `eva-evaluator.ts` scoring verbatim; the driver just parameterizes the config and aggregates.

**B — task-success metric (net-new):** a voice adaptation of τ-bench/τ²-bench — a small set of multi-turn
tool-use scenarios with a domain-rule success check, scored per config. This is the substantial new piece;
start with a **handful of deterministic tool-use tasks** + a rule-based success scorer (not the full τ-bench),
enough to detect a task-success regression between configs. Grow the task set later.

**Output:** `scripts/eval/interaction-config-sweep.ts` → a Markdown/JSON table
(config × {turnTakingTimingScore, overlapScore, avgResponseLatencyMs, taskSuccessRate}) + a baseline JSON to
gate against, reproducible from one command (`smoke:interaction-eval-matrix`).

**Verdict rule (RFC §9.4):** thesis proven iff `cascade+VAP+rich-seam` matches `native-realtime` on
turn-taking without a task-success regression. Do NOT use OpenAI's τ³-Voice-Telecom (vendor-internal).

## Honest gating / cost
- **Depends on C5** (VapInteractionPolicy) for the VAP configs — build the driver after C5 lands + verifies.
- **Live + credit-heavy:** the examiner is a live bot-to-bot smoke; a full matrix across configs × perturbations
  costs provider credits. First cut: the driver + the offline-scorable configs + a small task set, run at
  reduced repeats; the full live matrix is a documented, credit-budgeted follow-up (manager runs smokes).
- **Manager runs all live smokes** (per the division-of-labor rule).

## Build steps (after C5)
1. `scripts/eval/interaction-config-sweep.ts` — parameterize the examiner by interaction config; loop configs;
   reuse `eva-evaluator.ts`; emit the per-config turn-taking rows.
2. `scripts/eval/task-success.ts` — N deterministic tool-use tasks + a rule-based success scorer; run per config.
3. Merge into one table + baseline JSON; add `smoke:interaction-eval-matrix`.
4. Unit-test the scorers (deterministic inputs → expected scores); manager runs the live sweep at reduced
   repeats, records the table + baseline, documents the cost.
