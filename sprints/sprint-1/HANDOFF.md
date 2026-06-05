# Handoff — Sprint 1 → Sprint 2

> **One page. Read this before doing anything else.** Depth in [`WARMDOWN.md`](./WARMDOWN.md).

---

## State of the world (one paragraph)

Sprint 1 (Re-home the bridge) is complete. `AISDKBridgePlugin` is gone — the production plugin is now `ReasoningBridge`, which drives the `Reasoner` seam internally via a 6-case `ReasoningPart` switch (net −194 lines in `index.ts`), with the 9 bridge tests' assertions byte-for-byte unchanged. Every call site constructs it explicitly with `new ReasoningBridge(fromStreamText({...}))` (no auto-wrap); provider config lives in the adapter wrap, bridge config (`timeout_ms`/`max_history_turns`/retry) stays in `initialize`. It is **deployed live** (Cloudflare Version `cc9236aa`) and a real `/ws` turn transcribes + returns TTS; the re-home is latency-neutral vs the S1-00 baseline. The seam is now proven end-to-end with the AI SDK backend — Sprint 2 adds a second backend (Mastra) behind the same seam.

---

## Sprint 2 goal (verbatim from WBS)

**A Mastra `Agent` drives the same `ReasoningBridge` via `fromMastraAgent`, with a live worker turn through a Mastra backend, the edge bundle still clean, and LLM-TTFT within budget.**

Full section: `sprints/WBS.md` § Sprint 2 (stories S2-01…S2-03).

---

## Read these first (in this order, before delegating any story)

1. `sprints/STATE.md` — active sprint + load-bearing list.
2. `sprints/WBS.md` § Sprint 2.
3. `sprints/sprint-1/WARMDOWN.md` §9–10 (retro + pointers) — esp. the Mastra wire-shape + edge-bundle traps.
4. `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` — the adapter shape `fromMastraAgent` mirrors (one shared no-buffering mapping generator → `ReasoningPart`).
5. `packages/voice/src/reasoner.ts` — the seam contract.
6. `docs/rfc-reasoner-bridge.md` §4.3 (Mastra chunk → `ReasoningPart` table), §9 (edge-bundle weight + wire-shape risks), §8 commits 2.1–2.4, §7a (zero-delay queue, no accumulation).

---

## Traps to know about

- **Mastra wire shapes are doc-derived, not build-verified** — confirm `processDataStream` chunk fields (`payload.text`/`payload.{toolCallId,toolName,args}`/etc.) against the **pinned `@mastra/core`** at S2-01 *before* finalizing the mapping (mirror how the `ai@6` `TextStreamPart` risk was retired in Sprint 0: read the installed `.d.ts`).
- **Edge-bundle weight:** `@mastra/core` may pull Node-only deps — `verify-edge-bundle.sh` must stay clean; runtime-split Mastra to the Node build if it does (mirror the `voice-ws` `./node` export). This is a documented hard-flag.
- **No accumulation:** bridge Mastra's callback stream (`processDataStream({onChunk})`) to an async-iterable via a **zero-delay queue** — each `onChunk` enqueues + resolves the pending pull immediately (RFC §7a). A buffering slip here is the regression the latency gate catches.
- **Process (from S1-02):** for any config-migration brief, paste the **verbatim** original config block, not a keyword grep. Lead proof-JSON brief snippets with `"schema_version": 1`.

---

## Open issues that block sprint 2

No open blockers. (KI-1-02 is a backlog nicety.)

---

## Start by running

```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx && cat sprints/STATE.md && git branch --show-current && pnpm -r typecheck && pnpm -r test
```

Latency gate (credit-saving): `SYRINX_WS_MAX_TURNS=1 pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-interactive` vs the S1-00 band in `docs/latency-budget.md`.

---

## When you're done

Long-running managed program: this session advances to Sprint 2 (Step 4) without a fresh paste. A new session resumes by pasting `sprints/SESSION_KICKOFF_PROMPT.md` + reading `sprints/STATE.md` + this HANDOFF.
