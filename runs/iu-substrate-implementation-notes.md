# IU Substrate (Phase 0) — implementation notes

Assumptions, decisions not in the spec, deviations and why, root causes found.
Governed by `docs/rfc-incremental-unit-substrate.md`; the RFC wins on conflict.

## Load-bearing assumptions
- Build branch `plan/iu-substrate` (off `main`) — the repo default is `main` and the
  global rule forbids mid-sprint commits to it; Phase 0 merges via PR at the end.
- IC = `grok` (user directive this session; overrides the `delegation-worker-preference`
  memory's pi-glm default). Manager runs all live smokes (`manager-runs-smokes`).
- Baseline (2026-07-09): `pnpm -r typecheck` green except the single known pre-existing
  failure `examples/02-hello-voice-headless/scripts/run-studio-bargein-e2e.ts` (missing
  `playwright-core`). `packages/core` + `packages/tts-core` clean.

## Decisions

### D-1 (Sprint 0) — ledger anomaly seam is an `onEvent` hook, not a bus import
RFC §4.2 says an idempotent terminal op is "a no-op + a debug event" and an unknown-id
op is a "recoverable `llm.error` (`component: "iu_ledger"`), fail-open." But §12 Q2 chose
a **standalone** ledger, "testable in isolation." A pure `packages/core` class importing
`pipeline-bus`/`packets` to emit those events would couple the substrate to the bus and
break that isolation. **Decision:** `InMemoryIuLedger` takes an optional constructor
`onEvent?(a: IuLedgerAnomaly)` (default no-op). The ledger stays dependency-free and
synchronous; a consumer in C2+ passes a hook that turns anomalies into the `iu_ledger`
debug / `llm.error` packet. Faithful to §4.2 (fail-open, observable) and §12 Q2 (standalone).

### D-2 (Sprint 0) — three WBS stories briefed as one atomic IC story
S0-01/02/03 are one cohesive file-pair (types inert without ledger; ledger untestable
without both). Briefed as one `S0-01` story, committed `[S0-01]`. See `sprints/sprint-0/PLAN.md` §0.

### D-3 (Sprint 1) — C5 rescoped: premise stale, value folded into C2, epoch reshape deferred
Factory §3 red gate on C5: its proof (`telephony reaches turn 2+`) is already green.
Confirmed in code that C5's premise is stale (bug fixed in v4.1.0):
- telephony mints per-turn `<base>-t<n>` (`outbound-playout-pipeline.ts:46-66`; `edge-twilio.ts:247-251`);
- poison sets bounded/self-evicting (`deepgram/stt.ts` MAX_RETIRED_CONTEXTS/boundedAdd; `tts-core/engine.ts` MAX_CANCELLED_CONTEXTS/clearCancelledIfDrained).
Confirmed no consumer needs a first-class epoch (speculative staleness = contextId equality, `aisdk/src/index.ts:165,212,234`).
**Decision:** defer the standalone 15-file `{contextId,iuId,epoch}` reshape to backlog B-05 (consumer-gated);
fold C5's real value (ledger producer + first-class turn identity) into C2, delivered by its first consumer.
`contextId` stays per-turn; leaf plugins untouched. User directive: "rescope, not thin, based on current
state, reevaluate." Full write-up: `docs/rfc-incremental-unit-substrate-amendment-C5.md`. Board comment on the
IU design doc. Resequenced: S1=C2+identity, S2=C3, S3=C4, S4=closeout.

## Deviations
- Sprint sequence deviates from RFC §8 chunk order (C1→C5→C2→C3→C4) → now C1→C2→C3→C4, C5 deferred (D-3).
  Reason: RFC §8's front-loading of C5 assumed the P0 bug was open; it is not.

## Root causes found
(none yet)
