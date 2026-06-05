# Sprint 1 — Warm-down

> **Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05.
> **Sprint window:** 2026-06-05 (closed same day).
> **Outcome:** Goal achieved. The production bridge drives a `Reasoner` internally with zero behavior change, is constructed with explicit `fromStreamText(...)` adapters (no auto-wrap), and a live turn runs on the **deployed** Cloudflare worker — latency-neutral vs the S1-00 baseline.

---

## 1. Goal recap

**Sprint goal (from WBS):** the production bridge drives a `Reasoner` internally with zero behavior change (9 `index.test.ts` assertions unchanged; construction via `fromStreamFactory` — B2), explicit `fromAiSdkAgent(...)` construction (no auto-wrap — B3), live turn on the deployed worker within the S1-00 LLM-TTFT band (M3).

**Did we hit it?** **Yes.** All four stories shipped with PROCEED; Phase B = Approve (no blockers/majors). The 9 bridge tests' assertions are byte-for-byte unchanged; `index.ts` is a net −194 lines (the seam was the right abstraction). A real audio turn ran on the deployed edge (transcript + 141 KB TTS). Latency stayed within band across 6 + 2 runs.

---

## 2. Stories shipped

| Story | Status | Commit(s) | Notes |
|-------|--------|-----------|-------|
| S1-00 | Done | `e2b549c` | LLM-TTFT baseline (gpt-4.1-mini): P50 mean 3290 / P95 mean 4044 ms; gate P50 ≤ 3920 / P95 ≤ 4530. |
| S1-01 | Done | `cfd5f2b` | 6-case `ReasoningPart` switch; constructor unchanged; 18 tests green, assertions unchanged; latency-neutral (6 runs, P50 mean 2705 ms). |
| S1-02 | Done | `391d0f4` + `ad65e10` (mgr fix) | Rename → `ReasoningBridge(reasoner)`; config split across 4 call sites; `AISDKBridgePlugin` removed. Fix restored tools/history/timeout on the university path. |
| S1-03 | Done | (deploy/verify, no code) | Edge bundle clean; workerd miniflare turn; **deployed `/ws` turn** (transcript + 141 KB TTS); Version `cc9236aa`. |

No stories slipped.

---

## 3. What's working

- `ReasoningBridge` drives the `Reasoner` seam in prod; the AI SDK path is `fromStreamText(...)` wrapped explicitly at every call site. `AISDKBridgePlugin` is gone.
- Deployed worker `https://syrinx-voice-server-workers.mithushancj.workers.dev` (Version `cc9236aa`) serves real turns: transcript *"Can you help me reset my student portal password?"* + 141,236 bytes TTS.
- Latency-neutral: S1-01 P50 mean 2705 ms (faster than baseline 3290), within band.
- The 9 bridge tests are an unchanged behavioral oracle; workspace `pnpm -r typecheck && pnpm -r test` green.

---

## 4. What's not working / known issues

| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| KI-1-01 | `llm.finish_step_reason` (per-step Background metric) dropped in the re-home — RFC §4.3 drops non-error finish-steps; not test-asserted. | nit | — | accepted (proceed-S1-01) |
| KI-1-02 | Deployed-turn driver is a one-off in `.handoff/` (not a repeatable smoke). | minor | backlog | promote to `examples/.../scripts/` if a deployed smoke is wanted |
| KI-1-03 | Harness `smoke:websocket-interactive` LLM leg is live-API-noisy (P95-over-3-turns ≈ slowest turn); gate banded for it. | info | — | documented in `docs/latency-budget.md` |

---

## 5. Decisions made

- **Decision:** config split — provider config (`model`/`system`/`tools`/`temperature`/`maxOutputTokens`/`maxSteps`/`timeout`) lives in the call-site `fromStreamText(...)` wrap; bridge keeps `timeout_ms`/`max_history_turns`/retry. **Rationale:** RFC §4.4/§4.5 — the bridge owns history/barge-in/retry; the backend (Reasoner) owns generation config. **Source:** `sprints/sprint-1/PLAN.md` + `.understanding/bridge-rehome.md`. **RFC amendment:** none.
- **Decision (M3 refinement):** the latency gate bands against the observed run-to-run variance of `smoke:websocket-interactive` (LLM leg is live-API-noisy), not the RFC's aspirational ~5%. **Source:** `docs/latency-budget.md` S1-00 section. **RFC amendment:** none (gate framing unchanged; band widened to reality).

---

## 6. Wiki / RFC amendments this sprint

No amendments. Public surface matches RFC §4.4 (`ReasoningBridge(reasoner)` + named adapters).

---

## 7. Metrics

- **Test count:** unchanged at the unit level (re-home preserved the 9 bridge tests + 9 adapter tests; workspace ~450 tests green).
- **LoC:** `index.ts` net −194 (the seam removed a switch + 4 helpers).
- **Latency (LLM-TTFT, gpt-4.1-mini, local harness):** baseline P50 mean 3290 / P95 mean 4044 ms; post-re-home P50 mean 2705 ms (6 runs) — within band, no seam regression.
- **Deploy:** Version `cc9236aa`, Worker Startup 40 ms, bundle 260 KB gz.
- **Provider credits:** switched the gate to short-fixture (`SYRINX_WS_MAX_TURNS=1`) mid-sprint per the user's directive.

---

## 8. Backlog updates

**Added:** BL — promote `.handoff/deployed-turn-proof.mjs` to a repeatable deployed-worker smoke (KI-1-02). **Promoted:** none. **Removed:** none. (B-01…B-04 unchanged.)

---

## 9. Retrospective

### Keep
The `.understanding/bridge-rehome.md` map made S1-01 a near-mechanical transcription with the preservation rules as a checklist — the highest-risk story (zero-behavior-change refactor) went clean in one shot. Banding the latency gate against *observed* harness variance (not a literature number) kept the gate honest and avoided false-fails on provider noise.

### Change
The S1-02 config-migration brief was built from a keyword grep and **missed three config keys** (tools/max_history_turns/profile-timeout) on the latency-critical path. Caught in proceed evidence, but it cost a manager fix. **Change: config-migration briefs paste the verbatim original config block, never a grep summary.** Also: lead every proof-JSON brief snippet with `"schema_version": 1` (S1-01's proof was invalid without it).

### Try next
For Sprint 2 (Mastra), confirm the Mastra wire shapes (`processDataStream` chunk fields, `tool-call-suspended`, `resumeStream`) against the **pinned `@mastra/core`** version at S2-01 *before* finalizing the mapping — via a scripted shape probe or the installed `.d.ts` (the same way the `ai@6` `TextStreamPart` risk was retired in Sprint 0).

---

## 10. Pointers for the next sprint (Sprint 2 — Mastra adapter)

- **Files to read first:** `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` (the adapter shape to mirror for Mastra), `packages/voice/src/reasoner.ts` (the seam), `docs/rfc-reasoner-bridge.md` §4.3 (Mastra → `ReasoningPart` mapping table) + §9 (edge-bundle weight risk) + §8 commits 2.1–2.4.
- **Traps:** (1) **confirm `@mastra/core` wire shapes against the pinned version before finalizing the mapping** (RFC §9 — taken from docs, not a running build). (2) Bridge Mastra's callback stream (`processDataStream({onChunk})`) to an async-iterable via a **zero-delay queue** — no accumulation (RFC §7a). (3) **Edge-bundle weight:** `@mastra/core` may pull Node-only deps — `verify-edge-bundle.sh` must stay clean; runtime-split Mastra to the Node build if needed (mirror the `voice-ws` `./node` export). (4) The Reasoner-only constructor + explicit-wrap pattern is set — Mastra wires via `new ReasoningBridge(fromMastraAgent(agent))`.
- **Gate methodology:** short-fixture latency (`SYRINX_WS_MAX_TURNS=1`) vs the S1-00 band; edge bundle clean; opt-in worker turn.
- **Open RFC amendments in flight:** none.

---

## 11. Closeout

- [x] All Sprint-1 stories committed on `v2` (`e2b549c`, `cfd5f2b`, `391d0f4`, `ad65e10`).
- [x] Phase B review complete — Approve (`review-sprint.md`); m1 fixed in `ad65e10`.
- [x] Deployed to production (Version `cc9236aa`) — user-authorized; deployed-edge turn verified.
- [x] `sprints/sprint-1/HANDOFF.md` written; `sprints/STATE.md` advanced to Sprint 2.
- [x] Backlog delta (KI-1-02) noted.

Sprint 1 is closed.
