# RFC amendment — C5 rescope (turn-epoch identity)

**Amends:** `docs/rfc-incremental-unit-substrate.md` §8 C5, §2, §3 REQ-1
**Author:** Opus 4.8 (1M) manager, 2026-07-09
**Status:** Ready to implement (supersedes C5-as-written)
**Trigger:** Factory §3 red gate — C5's proof (`cmd:telephony-multiturn`, "telephony reaches turn 2+") is already green in the current tree.

---

## 1. Why C5 is being rescoped

C5 as written is a `contextId → {contextId, iuId, epoch}` reshape whose stated purpose is to fix the **telephony P0 turn-boundary cluster**: "telephony reuses one `contextId` per call" and "per-context poison sets clear only on `close()`" (RFC §2, quoting `.understanding/syrinx-voice-engine-understand.md`, dated **2026-07-02**).

**Both premises are stale — the bug is already fixed in the current tree (shipped v4.1.0):**

1. **Telephony already mints a per-turn `contextId`.** `installTelephonyTurnRotation()` rotates `` `${contextBase}-t${turnCounter}` `` on every `eos.turn_complete` for all carriers (`packages/server-websocket/src/outbound-playout-pipeline.ts:46-66`), with `edge-twilio.ts:247-251` doing it inline. Its own doc-comment names the exact bug the RFC says is open: *"Reusing one id for the whole call therefore makes the agent go deaf/mute after turn 1."*
2. **Poison sets are bounded + self-evicting**, not clear-only-on-`close()`: deepgram `MAX_RETIRED_CONTEXTS=256` + `boundedAdd` (`packages/deepgram/src/stt.ts:52-59,462,483`); tts-core `MAX_CANCELLED_CONTEXTS=256` + `clearCancelledIfDrained` (`packages/tts-core/src/engine.ts:28,271-272,310`).

So the functional payoff C5 exists to deliver is **already banked**. Building the full reshape now would be a ~15-file behavior-preserving refactor with no behavior change.

## 2. Does any consumer need a first-class `epoch`?

Checked, in code — **no**:

- **C2 (speculative generation):** detects a stale draft by **`contextId` equality** only — `draft.contextId === eos.contextId`, `speculativeDraft?.contextId === contextId` (`packages/aisdk/src/index.ts:165,212,234`). No monotonic ordering needed.
- **C3 (heard-prefix commit):** keys the committed assistant IU on the assistant turn's `contextId`. No epoch.
- **C4 (poison-set migration):** the ledger keys on `IncrementalUnitId`; `iuId = contextId` suffices.

The per-turn `contextId` is a **complete turn identity** for every current consumer. A blanket `epoch` field read by nobody is speculative capability (RFC §2.3 drawback; violates zero-tech-debt / build-for-one §2).

**Crucial coupling fact:** the current fix works *because* `contextId` is per-turn — leaf STT/TTS plugins retire finalized/cancelled per-turn ids. The RFC's ideal split (`contextId` = stable session id + `epoch` = per-turn) would re-break turn-2 in every leaf plugin unless all of them simultaneously adopt `(contextId, epoch)`. That coupling *is* the 15-file cost, and it buys nothing today.

## 3. The rescope (what C5 becomes)

**C5's genuine, non-speculative value — delivered by its first real consumer, not as a standalone reshape:**

- **Give the dormant `IuLedger` a producer.** Nothing writes to the ledger yet (S0 shipped it dormant). Its first producer is C2's speculative path, which constructs a `user_turn` IU per turn. This is where turn identity first meets the ledger.
- **Promote the turn counter to a first-class `epoch` — where it's produced, not across every packet.** The monotonic counter already exists implicitly (telephony `turnCounter`; browser rotates per turn). C5-rescoped stamps a real `epoch` into the `IncrementalUnitId` at the point the core constructs IUs, sourced from that counter. `contextId` **stays per-turn** (leaf plugins untouched; no blast radius).

**Resequence:**

| Old | New (this amendment) |
|-----|----------------------|
| Sprint 1 = C5 (standalone 15-file epoch reshape) | **Sprint 1 = C2 (speculative-on-ledger) + first-class turn-identity producer** (the ledger's first producer; `epoch` promoted from the existing turn counter, stamped into IU ids; leaf plugins + `contextId` semantics unchanged) |
| Sprint 2 = C2 | Sprint 2 = C3 (heard-prefix commit) |
| Sprint 3 = C3 | Sprint 3 = C4 (migrate poison-sets → ledger; delete dual bookkeeping) |
| Sprint 4 = C4 + closeout | Sprint 4 = closeout + the deferred items below (only if a consumer forces them) |

**Deferred to backlog (consumer-gated, not dropped):**
- **B-05 — `contextId` → stable-session-id + per-turn `epoch` split** (the full RFC-C5 reshape). Earliest: when a consumer needs epoch **ordering** (know turn N < N+1) or when C4's poison-set migration makes `contextId`-as-session-id clean. No consumer needs it today.
- **B-06 — structural turn-boundary re-arm.** Today, turn-2 correctness depends on a hand-maintained list of per-turn Sets being cleared at the boundary (`voice-agent-session.ts:828-836`: "or turn 2+ inherits stale flags"). Real debt, but orthogonal to the IU substrate; harden it when the next per-turn Set is added.

## 4. Amended acceptance for Sprint 1 (C2 + identity producer)

- Speculative generation re-expressed on `IuLedger` (behavior-preserving; existing aisdk speculative tests pass **unchanged**; `SpeculativeHold` private state removed) — the original C2 bar.
- The ledger gains a real producer: a `user_turn` IU is `add`ed on `eos.interim` and `commit`/`revoke`d on `eos.turn_complete`/`eos.retracted`, keyed by `IncrementalUnitId { contextId, iuId: contextId, epoch }` where `epoch` is the monotonic per-turn counter promoted to a field (0 if a transport has none yet — acceptable; ordering has no consumer).
- No leaf STT/TTS plugin changes; `contextId` semantics unchanged; no new packet field read by nobody.
- The `onEvent` anomaly hook (S0 D-1) is wired to push the `iu_ledger` debug/`llm.error` packet at this consumer (its first real use).

## 5. Rollback

This amendment only *narrows and resequences*. The dormant ledger (S0) is untouched. If the full epoch split is later justified (B-05), it proceeds against the same ledger identity — no rework of Sprint 1's producer.
