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

### D-4 (Sprint 1) — what "remove SpeculativeHold in favor of the ledger" actually means
`SpeculativeHold` (aisdk/src/index.ts:62-66) fuses commit *state* (`promoted`, `failed`) with a
side-effect *buffer* (`buffered: Array<()=>void>`). Only the state is the ledger's job. **Decision:**
move `promoted`→`ledger.state==="committed"` and `failed`→`ledger.revoke`, KEEP `buffered[]` as the
delivery-gating mechanism. Collapsing the buffer into the ledger would break the side-effect gating
(test index.test.ts:848 "nothing ever pushed"). The 4 speculative characterization tests (809/848/880/912)
must pass unchanged (RFC §11 abort otherwise). epoch = per-bridge monotonic counter per turn contextId
(epochByContext); no consumer reads ordering yet. onEvent → reuse llm.error packet with component:"iu_ledger".

### D-5 (Sprint 2) — C3's premise is also stale; back half of Phase 0 is consolidation, not bug-fix
The heard-prefix truncation the RFC C3 calls "specified but unwired" (§2: "TtsPlayoutClock.positionMs
has zero consumers, client never sends playout_progress") is **already wired** in aisdk:
`computeSpokenPrefix` (index.ts:578-586) does word-boundary precision (`w.endMs <= playedOutMs`) with a
`spokenByContext` fallback; `commitInterruptedHistory` (:598) rewrites history to the heard prefix +
persists. Shipped in v4.x (G25). So C3, like C2, is "re-express existing wired behavior on the ledger",
not "wire an unwired guarantee".
**Pattern:** the RFC (2026-07-09) was written from the 2026-07-02 `.understanding/` snapshot; its functional
premises (telephony P0 open [C5/C4], heard-prefix unwired [C3]) are all stale — those shipped in v4.1.x.
The remaining Phase 0 chunks (C3 assistant-IU producer, C4 poison-set migration) are honest **zero-tech-debt
consolidation** (collapse 5 private sets into the one ledger), NOT the functional wins the RFC advertised.
Real value already banked: S0 (ledger) + S1 (speculative-on-ledger). Surfaced to user as an allocation
decision (continue consolidation vs bank real value + pivot to InteractionPolicy/reasoner-latency).

### D-6 (Sprint 3) — C4 as specified is net-harmful; two real findings instead
Mapped the deepgram/tts sets + the ledger injection. Three problems with C4-as-RFC-specified
("plugins read/write the ledger, delete the private sets"):
1. **No dual bookkeeping to delete.** Only deepgram `finalizedContextIds` and tts `cancelledContexts`
   are "ctx terminal" sets; the other deepgram sets (finalizeRequested/speechFinal/ignoreNextFinal)
   are request/dedupe/diagnostic state that does NOT map to an IU. The sets are NOT duplicates of the
   ledger — they're separate, correct, bounded, local guards. The genuinely-dual one (aisdk speculative)
   already moved to the ledger in S1.
2. **Migration increases coupling + adds races (Hazards A & B).**
   - deepgram: the user_turn IU exists ONLY in speculative mode and is committed by the bridge AFTER
     deepgram emits eos.turn_complete and needs the flag. Non-speculative = no IU at all. So deepgram
     would have to WRITE the ledger itself (co-own IU state cross-package), not query it.
   - tts: on barge-in the bridge COMMITS the assistant IU with a prefix (not revokes), and interrupt.tts
     (tts acts) is pushed BEFORE interrupt.llm (bridge writes ledger). So "is it revoked?" is the wrong
     predicate AND the ledger changes after tts already dropped audio. Migration would create the exact
     turn-boundary race class that's dangerous in a voice engine.
3. **The ledger is UNBOUNDED and never cleared (real leak).** `InMemoryIuLedger.clear` has no production
   caller (grep: only its own test). S1/S2 add user_turn + assistant IUs per contextId; nothing evicts.
   Telephony mints a new `-t<n>` contextId per turn → the ledger's byCtx Map grows forever. The private
   sets C4 would replace are bounded to 256 precisely for this. Migrating onto an unbounded ledger
   regresses memory.
**Decision (pending user):** do NOT migrate the deepgram/tts sets (net-harmful). Rescope C4 to the real
work: (a) fix the unbounded-ledger leak — bound it + wire `clear(contextId)` on turn-end/close; (b) document
why the RFC's "dual bookkeeping" doesn't exist. Surfaced to user (third premise-reality gap; the strongest).

## Deviations
- Sprint sequence deviates from RFC §8 chunk order (C1→C5→C2→C3→C4) → now C1→C2→C3→C4, C5 deferred (D-3).
  Reason: RFC §8's front-loading of C5 assumed the P0 bug was open; it is not.

## Root causes found
(none yet)
