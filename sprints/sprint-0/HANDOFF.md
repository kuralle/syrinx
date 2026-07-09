# Handoff — Sprint 0 → Sprint 1

> **One page. Read this before doing anything else.** Depth lives in [`WARMDOWN.md`](./WARMDOWN.md); this is the read-me-first.

---

## State of the world (one paragraph)

Sprint 0 (Ledger core, RFC C1) is complete. The IU substrate — `IncrementalUnit` + `InMemoryIuLedger` — now exists in `packages/core`, dormant and verified (225 core tests green). This gives Sprints 1–4 the single commit/revoke primitive they consume; nothing on the hot path uses it yet. Sprint 1 does **not** wire the ledger into consumers — it is identity-only (the `contextId → turn-epoch` reshape, RFC C5), the front-loaded prerequisite both other vNext RFCs depend on.

---

## Sprint 1 goal (verbatim from WBS)

**`IncrementalUnitId {contextId, iuId, epoch}` supersedes the `contextId = turn id` overload in packets and consumers, with browser-per-turn and telephony-per-call both correct.**

The full sprint section is at `sprints/WBS.md` § Sprint 1.

---

## Read these first (in this order, before delegating any story)

1. `sprints/STATE.md` — confirms the active sprint (1) and the load-bearing reading list.
2. `sprints/WBS.md` § Sprint 1.
3. `docs/rfc-incremental-unit-substrate.md` §8 C5, §2 (current `contextId` overload), §5.1 (structural before/after), REQ-1.
4. `.understanding/syrinx-voice-engine-understand.md` — the P0 turn-boundary cluster (`contextId = turn id`, poison sets clear only on `close()`, browser mints per-turn vs telephony reuses per-call).
5. `packages/core/src/packets.ts` — where turn-scoped packets carry `contextId` today.

**Before briefing S1:** run `/code-understand --path packages/core/src/voice-agent-session.ts` (and the STT/turn-boundary path) so the brief cites exact `file:line` for where `contextId`-as-turn-id is minted and consumed. S1 is a reshape (wider blast radius than S0).

---

## Traps to know about

- **Telephony vs browser turn identity:** telephony reuses one `contextId` per call; browser mints one per turn. S1's `epoch` must advance per-turn in **both** without breaking transport/session identity (`contextId` stays the transport id). This is the crux of C5 and the source of the P0 cluster.
- **Do not wire the ledger yet:** S0's `InMemoryIuLedger` is available but S1 is identity-only. Wiring speculative/barge-in/poison-sets to the ledger is S2–S4.
- **`verify-handoff-proof.sh` schema drift:** the gate script errors `KeyError: 'type'` on the current proof schema. Verify by re-running the worker's `commands_run[]` directly — do not rely on the script.

---

## Open issues that block sprint 1

No open blockers. Baseline is green except the known pre-existing `examples/02-hello-voice-headless` playwright-core typecheck failure.

---

## Start by running

```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx && git checkout plan/iu-substrate && cat sprints/STATE.md && pnpm --filter @kuralle-syrinx/core test
```

---

## When you're done

Continue in the same session to Sprint 2 (speculative-on-ledger, RFC C2) per the kickoff Step 4. A new-chat resume pastes `sprints/SESSION_KICKOFF_PROMPT.md` and picks up from `sprints/STATE.md`.
