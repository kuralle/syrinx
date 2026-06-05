# Proceed Evidence — `S2-01` fromMastraAgent adapter + chunk→part tests

> **Manager artifact — Phase A.**

---

## Story

- **Id:** `S2-01`
- **Commits:** `415f762` (manager setup: scaffold + install + RFC v2.2 amendment) + `c683d75` (IC: adapter + tests).
- **IC slug:** `s2-01` (`.handoff/brief-s2-01.md`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] `~/.agents/scripts/verify-handoff-proof.sh s2-01` → `PROOF_OK` (3 claims, 5 assertions; `schema_version` present).
- [x] Scope clean — only `from-mastra.ts` (create), `from-mastra.test.ts` (create), `index.ts` (stub→re-export). **No** RFC / `package.json` / `tsconfig` touched (those were the manager setup commit).
- [x] Adapter matches the verified mapping (RFC §4.3 v2.2): iterates `out.fullStream` with `for await`; `text-delta`→`payload.text` (accumulated), `tool-call`→`payload.{toolCallId,toolName,args}`, `tool-result`→`payload.{...,result}`, `error`→terminal `{type:"error"}`, `finish`→`payload.stepResult.reason` (stop→stop, tool-calls→tool, length→length; abnormal→terminal error), no-finish→terminal error. `tool-call-suspended` default-dropped (Sprint 3 marker present).
- [x] **Preservation parity with the AI SDK adapter:** `if (turn.signal.aborted) return;` guards the loop (barge-in = silent return); `recoverable = isRecoverable(categorizeLlmError(cause))`; no buffering (`for await … yield`).
- [x] **Decoupling:** `MastraAgentLike` is a minimal **structural** type — the concrete `@mastra/core` `Agent` is not imported. Defensive `String(...)`/`toRecord` coercions mirror `from-ai-sdk.ts`.
- [x] **History (RFC §4.5):** passes `turn.messages` + `userText` as the message list; agent runs stateless-per-turn (no Mastra memory competing with the bridge's barge-in history).
- [x] No `@ts-ignore`/`--no-verify`/silent-catch.

**Independent manager verification:**
- `pnpm --filter @asyncdot/voice-bridge-mastra typecheck` → exit 0.
- `pnpm --filter @asyncdot/voice-bridge-mastra test` → **7/7 pass**: happy path · error chunk · abnormal finish (content-filter) · finish(length) · dropped (reasoning-delta/workflow) · **no-buffering** (first delta before close) · **barge-in** (pre-aborted signal → no yield).
- `bash scripts/verify-edge-bundle.sh` → exit 0 — **`@mastra/core` (201 transitive pkgs) did not leak into the edge bundle** (the key §9 gate; this package isn't edge-imported yet, S2-02 keeps it Node-split).

**Verdict:** `PROCEED`

---

## One-line summary

`@asyncdot/voice-bridge-mastra` ships `fromMastraAgent(agent) → Reasoner` mapping `output.fullStream` `{type,payload}` chunks → `ReasoningPart` (verified `@mastra/core@1.41.0`), structurally identical to the AI SDK adapter, no buffering; 7/7 tests + edge bundle clean · `415f762`+`c683d75`.

---

## Notes

- RFC amended to v2.2 (manager, `415f762`): §2/§4.3/§7a/§9 corrected from `processDataStream` to the `fullStream` mechanism; §9 Mastra wire-shape risk **RESOLVED**. The seam/ReasoningPart/ReasoningBridge surfaces are unchanged — no design divergence, only a mechanism correction (simplification).
- **Carry to S2-02:** wire a real (OpenAI-backed) Mastra `Agent` via `new ReasoningBridge(fromMastraAgent(agent))` in a **Node-only** path (runtime-split — `@mastra/core` must stay out of the edge bundle); live turn + short-fixture latency gate. The deploy step is outward-facing — surface to the user first.
- `MastraChunk.payload` is typed `Record<string, unknown>` (tighter than the brief's `any`); the IC casts `stepResult` locally — fine.
