# Proceed Evidence — `S1-02` rename to ReasoningBridge; Reasoner-only constructor + explicit wraps

> **Manager artifact — Phase A.**

---

## Story

- **Id:** `S1-02`
- **Commits:** `391d0f4` (IC) + `ad65e10` (manager fix of a brief omission — see below) — `[S1-02] …`
- **IC slug:** `s1-02` (`.handoff/brief-s1-02.md`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] `~/.agents/scripts/verify-handoff-proof.sh s1-02` → `PROOF_OK` (3 claims, 4 assertions; `schema_version` present this time).
- [x] `validation_contract.assertions_satisfied` == `assertions_required` (`REQ-S1-02-rename`, `test:bridge_9_unchanged`, `cmd:typecheck_all`, `cmd:test_all`).
- [x] `AISDKBridgePlugin` **fully removed** (`grep -rn AISDKBridgePlugin packages examples --include=*.ts` → none); `ReasoningBridge(reasoner: Reasoner)` only; `buildReasoner` deleted; provider-config reads gone from `initialize` (timeout_ms/max_history_turns/retry kept).
- [x] `index.test.ts`: **no assertion lines changed** — only the 9 construction lines + import adapted to `new ReasoningBridge(fromStreamFactory(fn))` (B2).
- [x] `@ai-sdk/openai` (+`ai`) added to `voice-server-workers` + the example `package.json` (+ lockfile) — **necessary** (the call sites now import `createOpenAI`/`stepCountIs` directly), not scope creep.
- [x] Per-site provider config verified against the original blocks:
  - `live-session.ts` ✓ (temp 0.4/256/steps1/30s; old block had no tools/history/timeout → `bridge:{}` correct).
  - `run-one-turn.ts` ✓ (same defaults).
  - `run-university-support-baseline.ts` ✓ (tools `supportTools`, 0.2/180/steps4/45s; kept `bridge:{ timeout_ms: 45_000 }`).
  - `university-support-agent.ts` — **was wrong, fixed** (see below).

## HOLD → manager fix (root cause: my incomplete brief, not IC execution)

The S1-02 brief's per-site config **table omitted three values** the original `university-support-agent.ts` bridge config carried, so the IC (faithfully transcribing the table) dropped them:
1. `tools: studentRelationsTools` — the support agent could no longer tool-call (functional regression).
2. `max_history_turns: 20` — silently defaulted to 12 (shorter history window).
3. `timeout_ms: interactive ? 30_000 : 60_000` — the longform idle-timeout dropped 60s → 30s.

Manager fix `ad65e10` restored all three: `tools` + profile-dependent `timeout` in the `fromStreamText` wrap, and `max_history_turns: 20` + `timeout_ms: interactive ? 30_000 : 60_000` in `pluginConfig.bridge`. Fixed directly (manager) rather than re-delegated because the defect was the manager's spec, the fix is precise (~2 edits, one file), and it was verified immediately. The other three sites were correct as the IC delivered them.

**Independent manager verification (post-fix):**
- `pnpm -r typecheck` → exit 0 (incl. `tools: studentRelationsTools` fitting `StreamTextConfig.tools`).
- `pnpm -r test` → exit 0 — voice 186, voice-bridge-aisdk 18 (9 `index.test.ts` assertions unchanged), voice-server-websocket 197, voice-server-workers 9, example 60 (+skips).
- **Latency gate (short fixture, `SYRINX_WS_MAX_TURNS=1` per the credit-saving directive, ×2):** LLM-TTFT 2890 ms / 3236 ms — both within the S1-00 band (P50 ≤ 3920 / P95 ≤ 4530). Latency-neutral, and tool-calling restored matches the S1-00/S1-01 baseline conditions.

**Verdict:** `PROCEED`

---

## One-line summary

`AISDKBridgePlugin` → `ReasoningBridge(reasoner)` (no auto-wrap, B3); provider config moved to explicit `fromStreamText` wraps at all 4 call sites; `AISDKBridgePlugin` removed; one manager fix restored tools/history/timeout on the university path; workspace green, latency-neutral · `391d0f4`+`ad65e10`.

---

## Notes

- **Process learning:** when scoping a config-split brief, dump the *entire* original config block per site (not a keyword grep) — the grep that built the brief table missed the `tools`/`max_history_turns`/`timeout_ms` lines on the university path. Future config-migration briefs should paste the verbatim old block.
- All `pluginConfig.bridge` blocks now hold **bridge-level keys only** (`max_history_turns`/`timeout_ms`); provider config lives in the adapter wrap — the §4.5 split is clean.
- **Carry to S1-03:** the prod path (`live-session.ts`) is migrated and edge-relevant; S1-03 runs `verify-edge-bundle.sh` (the new `@ai-sdk/openai` import in the worker must stay edge-clean — it already was via the bridge) + the opt-in worker turn + **deploy** (outward-facing — surface to the user first).
