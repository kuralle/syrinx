# Sprint 2 — Plan

**Sprint name:** Mastra adapter
**Sprint goal (one sentence):** A Mastra `Agent` drives the same `ReasoningBridge` via `fromMastraAgent`, with a live worker turn through a Mastra backend, the edge bundle still clean, and LLM-TTFT within budget.
**Sprint window:** 2026-06-05 → 2026-06-12
**Author (main session):** claude-opus-4-8[1m] · manager · 2026-06-05

**Read first:** `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` (the adapter `fromMastraAgent` mirrors), `packages/voice/src/reasoner.ts` (the seam), the RFC §4.3 (amended this sprint — see below).

---

## 0. Wire-shape verification (manager, done at plan time — retires the RFC §9 Mastra risk)

`@mastra/core@1.41.0` installed + verified against its `.d.ts`. **The RFC §4.3/§7a Mastra mechanism was stale** and is amended this sprint (folded into S2-01, manager-applied):

- `Agent.stream(messages, opts?)` → `Promise<MastraModelOutput>`; iterate **`output.fullStream`** — a `ReadableStream<ChunkType>` (async-iterable in Node 18+/workerd), `{type, payload}`-wrapped. **Not** `processDataStream({onChunk})` (that's `@mastra/client-js`). → the adapter is structurally identical to `fromAiSdkAgent` (`for await … yield map(chunk)`); **no zero-delay queue** (§7a simplifies).
- Verified field names: `text-delta`→`payload.text`; `tool-call`→`payload.{toolCallId,toolName,args}`; `tool-result`→`payload.{toolCallId,toolName,result}`; `finish`→`payload.stepResult.reason` (an AI SDK `LanguageModelV2FinishReason` → reuse the AI SDK coercion: stop→stop, tool-calls→tool, length→length, abnormal→`error`); `error`→`payload.error`. `runId` on the output; `resumeStream(resumeData,{runId,toolCallId?})` exists (Sprint 3). Everything else → **default-drop**.
- **Edge weight:** `@mastra/core` pulled **201 transitive packages** → the adapter is **runtime-split to the Node build** (own package + a worker `./node` import path); `verify-edge-bundle.sh` is the gate. `@mastra/core` must never enter the edge bundle (documented hard-flag if it can't be kept out).

The package scaffold (`packages/voice-bridge-mastra/` — `package.json` with `@mastra/core` as **peerDependency** `>=1.41.0 <2` + devDependency, `tsconfig.json`, stub `src/index.ts`) + the install + the RFC amendment ship as the manager S2-01 setup commit.

---

## 1. Stories

Consolidated from WBS §Sprint 2 (S2-01 adapter + S2-02 tests are one shippable unit — a public surface ships *with* its tests, DoD #2 — mirroring how S0-02 delivered the AI SDK adapter+tests together; the WBS live story S2-03 is S2-02 here). Order: S2-01 → S2-02.

### `S2-01` — `@asyncdot/voice-bridge-mastra`: `fromMastraAgent(agent) → Reasoner` + unit tests

**Description:** Implement `packages/voice-bridge-mastra/src/from-mastra.ts` exporting `fromMastraAgent(agent: MastraAgentLike): Reasoner`, with one no-buffering async-generator mapping `output.fullStream` chunks → `ReasoningPart` per §0. Re-export from `src/index.ts` (replacing the stub). Unit tests in `from-mastra.test.ts` cover the full mapping table + barge-in/abort parity, driven by a **scripted `ReadableStream` of `{type,payload}` chunks (no network)**. History stays bridge-owned (RFC §4.5): the adapter passes the bridge's `turn.messages` + `userText` as the Mastra message list and runs the agent **stateless-per-turn**.

**Acceptance criteria:**
1. `fromMastraAgent` returns a `Reasoner`; `MastraAgentLike` is a **minimal structural type** (`stream(messages, {abortSignal?}) → Promise<{ runId: string; fullStream: ReadableStream<{type:string; payload:any}> }>`) — do **not** import the full `@mastra/core` `Agent` type (keeps the adapter decoupled; `@mastra/core` stays a peer/dev dep, types only).
2. The shared mapping generator implements §0's table, yields each part **immediately** (no buffering/accumulation beyond the `finish.text` running string), and is **terminal-correct**: `error`→terminal `{type:"error"}`; abnormal `finish.reason`→terminal `error`; `stop|tool-calls|length`→`{type:"finish", reason, text}` (text = accumulated); stream-ends-without-finish→terminal `error`. `recoverable = isRecoverable(categorizeLlmError(cause))`. `if (turn.signal.aborted) return;` guards the loop (barge-in = silent return, parity with the AI SDK adapter).
3. `tool-call-suspended` is **not** mapped this sprint (Sprint 3, S3-02) — it falls through to default-drop (leave a `// Sprint 3` marker).
4. `from-mastra.test.ts` (scripted `ReadableStream`, no network) covers: happy path (deltas + tool-call + tool-result + `finish:stop` → exact `ReasoningPart` sequence incl. accumulated `finish.text`); `error` chunk → terminal error; abnormal `finish` (`content-filter`) → terminal error; `finish(length)` → `finish:length`; a dropped chunk (`reasoning-delta`/a workflow chunk) emits nothing; **no-buffering** (first delta resolves before the source closes); **barge-in** (pre-aborted `turn.signal` → no parts / silent return).
5. `pnpm --filter @asyncdot/voice-bridge-mastra typecheck` + `test` green. **`bash scripts/verify-edge-bundle.sh` stays clean** (this package isn't edge-imported yet, but confirm the workspace install didn't leak `@mastra/core` into the edge build).
6. **(manager, this story)** RFC §2/§4.3/§7a/§9 amended to the verified `fullStream` mechanism + v2.2 changelog line.

**Files:** create `packages/voice-bridge-mastra/src/from-mastra.ts` + `from-mastra.test.ts`; replace `src/index.ts` stub with the re-export. (Scaffold + RFC amendment already in the manager setup commit.) Commit `[S2-01] fromMastraAgent adapter + chunk→part tests`.

**Demo artifact:** `from-mastra.test.ts` green (scripted `fullStream` → exact `ReasoningPart` sequence).

### `S2-02` — Drive `ReasoningBridge` with a Mastra agent (Node runtime-split) + live worker turn

**Description:** Wire a Mastra-backed `new ReasoningBridge(fromMastraAgent(agent))` into the worker/example via an explicit adapter (no auto-wrap — B3), **runtime-split so `@mastra/core` only loads on the Node build** (mirror the `voice-ws` `./node` export pattern); keep the edge bundle clean. Drive a live worker turn through a Mastra backend.

**Acceptance criteria:**
1. A Mastra `Agent` (real, minimal — e.g. an OpenAI-backed Mastra agent) drives `ReasoningBridge` via `fromMastraAgent(agent)` in a Node-only path; no `@mastra/core` in the edge bundle (`verify-edge-bundle.sh` clean — runtime-split via a `./node` export or a Node-only module if the worker references it).
2. `pnpm -r typecheck && pnpm -r test` green.
3. Live turn through a Mastra-backed bridge (workerd miniflare turn and/or deployed — **deploy is outward-facing, surface first**); transcript + TTS.
4. **Latency gate:** `SYRINX_WS_MAX_TURNS=1` `smoke:websocket-interactive` (or a Mastra-path equivalent) LLM-TTFT within the S1-00 band (P50 ≤ 3920 / P95 ≤ 4530). The seam adds ~0 (same as the AI SDK path).

**Files:** likely a new Node-split example/wiring + possibly a worker `./node` export. Commit `[S2-02] drive ReasoningBridge with a Mastra agent (Node-split) + live turn`.

**Demo artifact:** a live turn driven through a Mastra-backed `ReasoningBridge` (transcript + TTS) + edge-bundle-clean proof.

---

## 2. Universal DoD (per story)

- [ ] `pnpm --filter <pkg> typecheck`/`test` green (workspace-wide at S2-02).
- [ ] Behavioral coverage: mapping table (happy + error + abnormal-finish + dropped + no-buffering + barge-in).
- [ ] **Edge gate:** `verify-edge-bundle.sh` clean — `@mastra/core` never in the edge bundle (**hard-flag** otherwise).
- [ ] **Latency gate (S2-02):** short-fixture LLM-TTFT within the S1-00 band.
- [ ] Proof JSON (lead with `"schema_version": 1`) + manager PROCEED.
- [ ] No `--no-verify`/`@ts-ignore`/silent-catch.
- [ ] Atomic commit `[S2-{nn}]` on `v2`.

---

## 3. Test plan

| Story | Layer | Test | Fixtures |
|-------|-------|------|----------|
| S2-01 | unit | chunk→part mapping table + barge-in + no-buffering | scripted `ReadableStream<{type,payload}>` (no network) |
| S2-02 | edge + live | `verify-edge-bundle.sh` clean + Mastra-backed live turn + latency gate | real Mastra agent (OpenAI-backed); deployed/miniflare |

Not tested: suspend/resume (Sprint 3); `@mastra/ai-sdk` `toAISdkStream()` path (backlog B-03).

---

## 4. Demo plan

**Demo:** a live worker turn driven through a Mastra-backed `ReasoningBridge` (transcript + TTS) + the edge bundle staying clean + LLM-TTFT within the S1-00 band — the WBS Sprint-2 demo.

---

## 5. Risks specific to this sprint

| Risk | Detection | Mitigation |
|------|-----------|------------|
| `@mastra/core` (201 deps) bloats / breaks the edge bundle | `verify-edge-bundle.sh` | runtime-split Mastra to the Node build (`./node` export); never import it edge-side. **Hard-flag if unavoidable.** |
| `ReadableStream` async-iteration unavailable in a target runtime | typecheck + the no-buffering test | iterate via `for await`; fall back to `getReader()` loop if a runtime lacks `Symbol.asyncIterator` (Node 18+/workerd have it). |
| Mastra memory competes with the bridge's history (barge-in correctness) | barge-in parity test | run the agent **stateless-per-turn**; bridge passes `turn.messages` (RFC §4.5). Full reconciliation is Sprint-3/B4. |
| Mastra `finish.reason` enum differs from AI SDK | the abnormal-finish test | verified `LanguageModelV2FinishReason` (same enum); reuse the AI SDK coercion. |

---

## 6. Open questions

- **S2-02 live agent:** which model backs the demo Mastra agent? Default to an OpenAI-backed Mastra `Agent` (`gpt-4.1-mini`, same as the AI SDK path) so the latency comparison is apples-to-apples. Confirm at S2-02.
- **Resume (`resumeStream`) + `tool-call-suspended`** are verified to exist but are **out of scope** until Sprint 3 (S3-02).
