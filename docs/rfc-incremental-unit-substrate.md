# RFC: Incremental Units as the Syrinx substrate

**Category:** Architectural Change
**Author:** octalpixel
**Date:** 2026-07-09
**Status:** Implemented — released in 4.2.0 (2026-07-11). §8 chunks C1 (ledger core), C2
(speculative-on-ledger), C3 (assistant IU + heard-prefix) shipped, plus an unbounded-ledger leak fix.
**C4 rescoped** (the poison-set migration was net-harmful — no real dual bookkeeping existed) and
**C5 deferred** (premise stale; the telephony P0 it targeted was already fixed in v4.1.x) — see
`docs/rfc-incremental-unit-substrate-amendment-C5.md`.
**Reviewers:** (maintainer)
**Related:**
- `research/incremental-processing-deep-dive.md` (the academic grounding — verified sources)
- `docs/rfc-interaction-policy-seam.md` (turn detection → produces IU add/commit signals)
- `docs/rfc-half-cascade.md` (text-only front → IU output source)
- `docs/rfc-reasoner-latency.md` (speculative generation → the first IU commit/revoke consumer, shipped v4.1.0)
- `.understanding/syrinx-voice-engine-understand.md` (the `contextId = turn id` P0 cluster this reframes)
- Memory: `incremental-unit-substrate-insight`, `latency-is-top-priority`

---

## 1. Problem Statement

Syrinx has been building the same primitive five times under five names. Speculative generation
(`SpeculativeHold` promote/discard), eager end-of-turn (`eos.interim`/`eos.retracted`), barge-in truncation
to the heard prefix, preemptive TTS (proposed), and the `contextId → turn-epoch` reshape are all instances of
**one operation: hold a provisional hypothesis, then commit or revoke it as later evidence arrives.** That
operation was formalized in 2009 as the **Incremental Unit (IU) model** (Schlangen & Skantze) and is grounded
in 50 years of turn-taking psycholinguistics (see `research/incremental-processing-deep-dive.md`).

Because the primitive is implicit and re-implemented per feature, they do not compose: barge-in truncation
and speculative generation each invent their own "what was really committed" bookkeeping; the
`contextId = turn id` overload (the telephony P0 cluster) is a *missing commit boundary*; preemptive TTS would
add a sixth ad-hoc hold. Success: **one commit/revoke primitive over the `PipelineBus`** that these features
become thin consumers of, with a single tested implementation of "commit what is grounded, revoke what is not."

**This is an enabling-substrate RFC.** It does not add a user-facing feature; it makes the other three RFCs
cheaper and removes the P0 turn-boundary cluster. Measured success = the InteractionPolicy, half-cascade, and
reasoner-latency features are re-expressed as IU consumers with net-negative added bookkeeping, and the
barge-in-truncates-to-heard-prefix guarantee holds end-to-end (which it does not today).

### 1.1 Non-Goals / Out of Scope

- **Non-goal:** a fine-grained *sub-word* revision network (the full IU model's cascade). v1 is **turn/segment
  granularity** — the degenerate IU the frameworks already use — because LLM backends are natively batch and
  token-level revisability is unproven to pay (see §2.3).
- **Non-goal:** replacing the `PipelineBus` or `VoicePacket`. IU semantics are added *on* them, not instead.
- **Non-goal:** shipping the InteractionPolicy/VAP controller, half-cascade, or preemptive TTS themselves —
  this RFC provides the substrate they consume; each remains its own RFC.
- **Deferred:** incremental/​revisable TTS output (INPRO_iSS-style mid-utterance revision) — a later increment
  once the commit/revoke lattice exists.

## 2. Background

**Current state (from `.understanding/syrinx-voice-engine-understand.md`).** `contextId` doubles as the turn
id; per-context "poison" sets clear only on `close()`; browser transports mint a contextId per turn but
telephony reuses one per call. `TtsPlayoutClock.positionMs` has zero consumers and the client never sends
`playout_progress`, so "truncate history to what the user actually heard" is specified but not wired. These
are the symptoms the review flagged as the P0 cluster and proposed to fix with "a `contextId + generation
epoch`." That proposal is, in different words, an IU identity + commit state.

**What already emits IU-shaped signals.** The speculative path in `packages/aisdk/src/index.ts` already has
`SpeculativeHold` (buffered side effects), `promote` (commit), and `discard` (revoke), keyed off
`eos.interim` (add) / `eos.turn_complete` (commit) / `eos.retracted` (revoke) from `packages/deepgram/src/flux.ts`.
The `RealtimeBridge` emits assistant transcript deltas that are provisional until `eos.turn_complete`. The
seams already speak add/commit/revoke — they just do not share a vocabulary or a ledger.

### 2.2 Alternatives Considered

- **Alt A — leave it implicit, keep building per-feature holds.** Rejected: it is why barge-in truncation and
  speculative generation duplicate "what was committed" logic and why the P0 cluster exists. Each new latency
  feature (preemptive TTS next) pays the tax again. See `research/incremental-processing-deep-dive.md` §5.
- **Alt B — full fine-grained IU network (sub-word, cascaded revocation, per Schlangen & Skantze 2011).**
  Rejected for v1: LLM backends are batch; token-level revision is high-cost and unproven (§2.3). v1 takes the
  model's *identity + commit state* (the useful 80%), not its revision cascade.
- **Alt C — `contextId + generation-epoch` only (the understanding artifact's minimal fix).** Rejected as
  incomplete: it fixes turn identity but not the shared commit/revoke ledger, so speculative + barge-in still
  duplicate bookkeeping. This RFC is that fix *plus* the ledger — a strict superset, same reshape cost.

### 2.3 Drawbacks and Tradeoffs

- New core vocabulary (IU add/commit/revoke) every contributor must learn; mitigated by making the existing
  packets (`eos.*`, the speculative hold) the *canonical examples* rather than inventing parallel names.
- LLMs are natively batch: a commit/revoke lattice may buy nothing over the current degenerate whole-turn
  version on the LLM path. This RFC therefore ships the substrate + re-expresses existing features on it
  (behavior-preserving) and makes fine-grained revision a *measured* follow-up, not a v1 promise.
- Reshape touches turn-boundary code across core + STT + TTS + transports (the same blast radius the P0
  cluster already has); the payoff is doing that reshape once, principled, instead of per-feature.

## 3. Strict Requirements

- **REQ-1 (IU identity):** every turn-scoped artifact carries an `iuId` (stable) + `epoch` (monotonic),
  superseding the `contextId = turn id` overload. `contextId` remains the transport/session id.
- **REQ-2 (commit state):** an IU is in exactly one state — `hypothesized` | `committed` | `revoked`.
  Transitions are monotonic (`hypothesized → committed` or `hypothesized → revoked`; no un-commit).
- **REQ-3 (single ledger):** one `IuLedger` in `packages/core` records IU state per `contextId`; all consumers
  (speculative, barge-in, InteractionPolicy, TTS) read/write it rather than keeping private sets.
- **REQ-4 (commit boundary = heard prefix):** on interruption, the committed IU span is the **heard prefix**
  (from `TtsPlayoutClock` + word timestamps when available; `spokenByContext` fallback); everything after is
  revoked. This wires the guarantee the understanding artifact found unwired.
- **REQ-5 (behavior-preserving re-expression):** speculative generation and barge-in truncation are
  re-implemented as `IuLedger` consumers with **no behavior change** — existing characterization tests pass.
- **REQ-6 (no new latency):** the ledger is in-memory and synchronous; per-packet overhead is O(1) and adds ~0
  to the v2v budget (measured against the pre-reshape baseline).
- **REQ-7 (dual runtime + both topologies):** works on Node and Workers, cascade and realtime — it is a core
  primitive, above the transport/provider split.

## 4. Interface Specification

### 4.1 IU identity + state
- **Location:** `packages/core/src/incremental-unit.ts`
- **Signatures:**
  ```ts
  export type IuState = "hypothesized" | "committed" | "revoked";
  export interface IncrementalUnitId { readonly contextId: string; readonly iuId: string; readonly epoch: number; }
  export interface IncrementalUnit {
    readonly id: IncrementalUnitId;
    readonly kind: "user_turn" | "assistant_response" | "tts_segment";
    state: IuState;
    /** For assistant/tts IUs: the committed character/ms prefix (heard). */
    committedPrefix?: { chars?: number; ms?: number };
  }
  ```

### 4.2 IuLedger
- **Location:** `packages/core/src/iu-ledger.ts`
- **Signatures:**
  ```ts
  export interface IuLedger {
    add(iu: IncrementalUnit): void;                 // register a hypothesis
    commit(id: IncrementalUnitId, prefix?: { chars?: number; ms?: number }): void;
    revoke(id: IncrementalUnitId): void;
    get(id: IncrementalUnitId): IncrementalUnit | undefined;
    latest(contextId: string, kind: IncrementalUnit["kind"]): IncrementalUnit | undefined;
    clear(contextId: string): void;                 // on transport close only
  }
  ```
- **Behavior:** synchronous, in-memory, per-`contextId`. `commit`/`revoke` on an already-terminal IU is a
  no-op (idempotent) + a debug event. Never blocks the bus drain (REQ-6).
- **Error cases:** commit/revoke of an unknown `iuId` → recoverable `llm.error` (`component: "iu_ledger"`),
  fail-open (treat as no-op).

### 4.3 Packet alignment (no new packet types where existing ones suffice)
- `eos.interim` → `ledger.add(userTurn hypothesized)`; `eos.turn_complete` → `commit`; `eos.retracted` →
  `revoke`. `llm.delta`/`tts.text` under speculation → hypothesized assistant IU; promote → commit.
- `interrupt.tts` → `commit(assistant IU, prefix = heard)` then `revoke` the remainder (REQ-4).

## 5. Architecture and System Dependencies

### 5.1 Structural changes
```
BEFORE                                          AFTER
------                                          -----
contextId = turn id (overloaded)                IncrementalUnitId { contextId, iuId, epoch }
SpeculativeHold (aisdk-private)                 IuLedger (core) — speculative is a consumer
deepgram finalizedContextIds / poison sets      IuLedger commit/revoke (one ledger)
tts cancelledContexts (tts-core-private)        IuLedger revoke
heard-prefix truncation (specified, unwired)    IuLedger.commit(prefix = heard) — wired (REQ-4)
```
- **Created:** `incremental-unit.ts`, `iu-ledger.ts` in `packages/core`.
- **Re-expressed (behavior-preserving):** `aisdk` speculative hold, `deepgram` finalized-context drop,
  `tts-core` cancel bookkeeping, `voice-agent-session` barge-in truncation — all delegate to `IuLedger`.
- **Deleted after parity:** the per-package poison/cancelled/finalized sets the ledger replaces (no dual
  bookkeeping kept — zero-tech-debt).

### 5.2 Dependencies
- This RFC is the **substrate** the others sit on. Recommended order: land the ledger + reshape (this RFC) →
  then InteractionPolicy C1 and half-cascade C1 build against IU identity instead of `contextId=turn`.
- No new external services.

## 6. Pseudocode
```
# speculative generation, re-expressed
ON eos.interim(text, ctx):        iu = IU(user_turn, ctx, newEpoch); ledger.add(iu); startDraft(iu)
ON eos.turn_complete(text, ctx):  if draftMatches(text): ledger.commit(iu); promoteDraft()
                                  else: ledger.revoke(iu); regenerate()
ON eos.retracted(ctx):            ledger.revoke(iu); discardDraft()

# barge-in truncation, re-expressed (REQ-4)
ON interrupt.tts(ctx):
    heard = playoutClock.heardPrefix(ctx)         # ms + word-boundary chars
    aiIu  = ledger.latest(ctx, assistant_response)
    ledger.commit(aiIu, prefix = heard)           # what was heard is committed history
    truncateHistoryTo(heard)                       # revoke the rest — same op as discardDraft
```

## 7. Code Blueprint
```ts
// packages/core/src/iu-ledger.ts
export class InMemoryIuLedger implements IuLedger {
  private byCtx = new Map<string, Map<string, IncrementalUnit>>();
  add(iu: IncrementalUnit) { this.map(iu.id.contextId).set(iu.id.iuId, iu); }
  commit(id: IncrementalUnitId, prefix?: {chars?: number; ms?: number}) {
    const iu = this.get(id); if (!iu || iu.state !== "hypothesized") return;   // idempotent
    iu.state = "committed"; if (prefix) iu.committedPrefix = prefix;
  }
  revoke(id: IncrementalUnitId) {
    const iu = this.get(id); if (!iu || iu.state !== "hypothesized") return;
    iu.state = "revoked";
  }
  // get / latest / clear elided
}
```
Grounding: this generalizes `SpeculativeHold` (`packages/aisdk/src/index.ts:56-66`) to the bus, and gives the
`.understanding/` P0 cluster its principled fix. Academic basis + the exact framework→IU mapping table in
`research/incremental-processing-deep-dive.md`.

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding | Acceptance criteria |
|----|-------|-------|-----------|---------------------|
| C1 | `IncrementalUnit` + `IuLedger` (`InMemoryIuLedger`) with add/commit/revoke, idempotent, per-ctx | `packages/core/src/incremental-unit.ts`, `iu-ledger.ts` | REQ-1,2,3,6 | Unit tests: state machine monotonic; idempotent terminal ops; O(1); `clear` only on close |
| C2 | Re-express speculative generation on the ledger (behavior-preserving) | `packages/aisdk/src/index.ts` | REQ-5; existing speculative tests | aisdk speculative tests pass unchanged; `SpeculativeHold` private state removed in favor of ledger |
| C3 | Wire heard-prefix commit boundary on barge-in (the unwired guarantee) | `packages/core/src/voice-agent-session.ts`, `tts-playout-clock.ts` | REQ-4; new truncation test | On interrupt, history truncates to heard prefix (word-boundary when timestamps present); test proves committed==heard |
| C4 | Migrate poison/cancelled/finalized sets to the ledger; delete dual bookkeeping | `packages/deepgram/src/stt.ts`, `tts-core/src/engine.ts` | REQ-3,5 | Telephony multi-turn (the P0 cluster) reaches turn 2+ in a smoke; old sets deleted |
| C5 | `contextId → epoch` identity in packets (IU id) behind the ledger | `packages/core/src/packets.ts` + consumers | REQ-1 | Turn-boundary tests green; browser per-turn and telephony per-call both correct |

## 9. Validation and Testing

### 9.0 Validation contract
| ID | Source | Assertion |
|----|--------|-----------|
| REQ-2 | §3 | IU state transitions monotonic; terminal ops idempotent (unit) |
| REQ-4 | §3 | barge-in commits exactly the heard prefix; remainder revoked |
| REQ-5 | §3 | speculative + barge-in characterization tests pass unchanged |
| REQ-6 | §3 | ledger op p99 O(1); v2v `turn_latency` no regression vs baseline |
| test:iu-ledger | §9.1 | ledger state machine + idempotency |
| test:heard-prefix-commit | §9.1 | interrupt → committed span == heard span |
| cmd:telephony-multiturn | §9.3 | Node telephony reaches turn 2+ (P0 cluster resolved) |

### 9.1 Fail-to-pass tests
- `iu-ledger.test.ts` — add/commit/revoke monotonicity + idempotency + per-ctx isolation.
- `heard-prefix-commit.test.ts` — barge-in commits the heard prefix (word-boundary + ms fallback).
- `speculative-on-ledger.test.ts` — speculative promote==commit, discard==revoke, behavior unchanged.

### 9.2 Regression
- `pnpm -r typecheck && pnpm -r test` (known pre-existing playwright-core failure excepted).
- All barge-in / turn-arbiter characterization tests unchanged (REQ-5).

### 9.3 Validation commands
```bash
pnpm -r typecheck && pnpm -r test
# the P0 cluster proof — multi-turn Node telephony must reach turn 2+:
pnpm --filter @kuralle-syrinx/examples smoke:telnyx-emulator
```

## 10. Security Considerations
No new attack surface: `IuLedger` is in-process, in-memory, per-`contextId`, cleared on close. It replaces
existing in-memory sets; it does not persist or transmit anything new.

## 11. Rollback and Abort Criteria
- **Rollback:** C1 (the ledger) ships dormant; C2–C5 are per-consumer migrations, each independently
  revertible to its old private bookkeeping.
- **Abort C2/C4 if:** re-expression changes behavior (a characterization test flips) that cannot be made
  equivalent — stop, keep the private set, and treat the divergence as a real bug to triage first.
- **Symptom-patch stop:** if the heard-prefix commit (C3) "works" only for one transport by special-casing it
  rather than through the ledger, stop — the point is one commit boundary for all transports.

## 12. Open Questions
- **Q1 — v1 granularity: turn/segment vs fine-grained sub-word?** Tradeoff: fine-grained matches the full IU
  model but is unproven/expensive on batch LLMs. **Proposal:** turn/segment granularity in v1; make
  fine-grained a measured follow-up gated by the InteractionPolicy eval harness (degenerate vs fine-grained).
- **Q2 — Ledger ownership: standalone core service vs folded into `VoiceAgentSession`?** Tradeoff: separation
  vs fewer moving parts. **Proposal:** standalone `packages/core/src/iu-ledger.ts` (testable in isolation),
  instantiated by `VoiceAgentSession`.
- **Q3 — Persist committed IUs to the durable store (G4)?** Tradeoff: durable resume fidelity vs scope.
  **Proposal:** v1 in-memory only; the durable reasoner store already persists committed *history* — the
  ledger's committed prefix feeds it, no separate persistence needed yet.
- **Q4 — Do this before or after InteractionPolicy/half-cascade?** Tradeoff: substrate-first is cleaner but
  delays visible features. **Proposal:** land C1 + C5 (identity) first because both other RFCs' C1 depend on
  turn identity; migrate C2–C4 opportunistically. This RFC is the shared prerequisite, so front-load only the
  identity piece.

## Risks
- **Over-abstraction** — building IU machinery no consumer needs. Mitigated by REQ-5 (only re-express existing
  features; add nothing speculative) and Q1 (degenerate granularity until measured).
- **Reshape blast radius** — turn-boundary code across five packages. Mitigated by per-consumer migration
  (C2–C5 independently revertible) and the fact that the P0 cluster forces this reshape anyway.
- **No measurable win on LLM backends** — the honest risk that turn-granularity IU == today's behavior with
  more ceremony. Mitigated: the win is not latency, it is *collapsing five bookkeeping implementations into one
  tested primitive + wiring the heard-prefix guarantee*; that stands even if fine-grained never pays.
