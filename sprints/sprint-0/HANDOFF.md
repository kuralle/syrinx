# Handoff — Sprint 0 → Sprint 1

> **One page. Read this before doing anything else.** Depth lives in [`WARMDOWN.md`](./WARMDOWN.md); this is the read-me-first.

---

## State of the world (one paragraph)

Sprint 0 (Seam foundation) is complete. The `Reasoner` seam + `ReasoningPart` union now exist in `@asyncdot/voice` (`packages/voice/src/reasoner.ts`, exported), and three AI SDK adapters (`fromAiSdkAgent`/`fromStreamText`/`fromStreamFactory`) normalize an `ai@6` `TextStreamPart` stream into `ReasoningPart`s through one no-buffering mapping generator (`packages/voice-bridge-aisdk/src/from-ai-sdk.ts`). Nothing that runs in the conversational path or the edge bundle was touched — `AISDKBridgePlugin` is byte-for-byte unchanged and its 9 tests still pass — so Sprint 1 starts from a green, purely-additive base and the seam is ready to be driven internally.

---

## Sprint 1 goal (verbatim from WBS)

**The production bridge drives a `Reasoner` internally with zero behavior change (the 9 `index.test.ts` tests' assertions unchanged; construction adapts via `fromStreamFactory` — B2), is constructed with an explicit `fromAiSdkAgent(...)` (no auto-wrap — B3), and runs a live turn on the deployed worker with LLM-TTFT within the S1-00 baseline band (M3).**

The full sprint section is at `sprints/WBS.md` § Sprint 1 (stories S1-00 … S1-03).

---

## Read these first (in this order, before delegating any story)

1. `sprints/STATE.md` — confirms the active sprint (1) and the load-bearing reading list.
2. `sprints/WBS.md` § Sprint 1.
3. `sprints/sprint-0/WARMDOWN.md` §10 (pointers) + §4 (known issues) — the carry-forward traps.
4. `packages/voice-bridge-aisdk/src/index.ts` — `AISDKBridgePlugin`, the thing being re-homed; `processTurn` part-switch (`:167`) and `streamResponse` (`:263`).
5. `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` — the adapter it will be driven by (esp. `fromStreamFactory`, the B2 seam for the 9-test re-home).
6. `docs/rfc-reasoner-bridge.md` §4.4 (generalized bridge), §4.5 (what stays verbatim), §7a + M3 (latency gate), §8 commits 1.0 / 1.3–1.5.

**Run `/code-understand` on the bridge re-home before briefing S1-01** — the kickoff flags Sprint 1's re-home as warranting it; link `.understanding/<slug>.md` in the brief's Read-These-First.

---

## Traps to know about

- **Signal-abort vs `abort` stream-part:** the adapter maps an `abort` *part* → `error` (`from-ai-sdk.ts:152`), but the bridge must still treat `signal.aborted` (barge-in) as a **silent `return`**, never an `llm.error`. Don't collapse the two when wiring the 6-case switch.
- **`fromStreamText` needs `maxRetries:0`:** today's bridge sets it (`index.ts:279`); the S1-02 live call site must pass it through `StreamTextConfig` (KI-0-02).
- **Abnormal terminal `finish` → `error` (PLAN §6 decision):** validate this against the 9 tests during the re-home — esp. the `finish(length)` → `llm.error` token-limit test, which now flows as a `finish:length` part the bridge must reject.
- **S1-00 is first:** capture the latency baseline before any refactor; it is the denominator for the whole program's latency gate.

---

## Open issues that block sprint 1

No open blockers. (KI-0-01 and KI-0-02 are minor forward-looking notes, not blockers.)

---

## Start by running

```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx && cat sprints/STATE.md && git branch --show-current && pnpm -r typecheck && pnpm -r test
```

---

## When you're done

This is a long-running managed program: after this warm-down the same session advances to Sprint 1 (Step 4) without a fresh paste. A new session resumes by pasting `sprints/SESSION_KICKOFF_PROMPT.md` and reading `sprints/STATE.md` + this HANDOFF.
