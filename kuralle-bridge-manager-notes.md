# Kuralle ⇆ Syrinx bridge — manager notes

Goal: bridge `@kuralle-agents/core` (kuralle-agents) as a reasoning backend for the Syrinx
voice engine; prove multi-turn conversation with **kuralle-owned memory**; extract a clean
bridge package. Inverted approach: got it working in-place, then destructed into a package.

## What shipped (verified live by manager)

| Chunk | Worker | Status | Key files |
|---|---|---|---|
| A — in-place bridge + live memory smoke | cursor | shipped | `examples/02-hello-voice-headless/{src/university-support-kuralle.ts, scripts/run-kuralle-memory-smoke.ts}` |
| B — extract to package | cursor | shipped | `packages/kuralle/**` (`@kuralle-syrinx/kuralle`) |
| C — Cloudflare composition | manager | designed (below) | (wiring point grounded; no live deploy) |

The bridge: `fromKuralleRuntime(runtime, { sessionId }) → Reasoner` — wraps kuralle's
`runtime.run({ input }).events`, maps `HarnessStreamPart → ReasoningPart`, and is wired with
`new ReasoningBridge(fromKuralleRuntime(...))`. It mirrors `packages/mastra/from-mastra.ts`.

## The decisive design choice — kuralle owns memory

The adapter **ignores `turn.messages`** and passes only `turn.userText` as `input`. Syrinx's
`ReasoningBridge` sliding-window history is therefore NOT the memory source; kuralle's session
store keyed by a stable `sessionId` is the *only* possible source of cross-turn recall. So the
smoke is a real proof: turn-2 ("what's my name / program?") can only succeed via kuralle memory.

**Verified live, 4 independent runs** (2 worker + 2 manager), each with different LLM wording:
turn-1 states "My name is Priya, applying for the computer science masters" → turn-2 reply
contains "Priya" + "computer science master's". PASS every run.

Gates re-run by manager: `packages/kuralle` typecheck ✓, 6/6 unit tests ✓ (incl. an assertion
that only `userText` reaches `run`), example typecheck ✓, live smoke ✓.

## Finding — latency (CORRECTED with a head-to-head benchmark)

An earlier draft of these notes claimed kuralle was ~2–3s and "above budget." **That was wrong** —
it conflated the voice-smoke TTFT (cold start + STT-finalize/endpointing anchor in the custom
multiturn driver) with kuralle's reasoner cost. An isolated reasoner benchmark
(`scripts/bench-reasoner-ttft.ts`, STT/TTS bypassed, same model gpt-4.1-mini, stream→first
text-delta) falsifies it:

| reasoner | TTFT median | samples (ms) |
|---|---|---|
| ai-sdk (`fromStreamText`) | 861ms | 768, 769, 861, 1603 |
| mastra (`fromMastraAgent`) | 807ms | 597, 748, 807, 2434 |
| kuralle (`fromKuralleRuntime`) | 801ms | 751, 790, 801, 974 |
| kuralle + working-memory | 1001ms | 667, 830, 1001, 1029 |

**All three are statistically tied (~800ms median).** The occasional 1.6–2.4s spikes appear in
ALL three — OpenAI API jitter, not a kuralle property. Kuralle's internal phase trace shows the
first text-delta at +781ms with **no pre-model gap** (no `flow-enter`/selection delay): the time
IS the model's own TTFT. So for a **single agent with no routes/flows/refinement/knowledge**,
kuralle's base overhead over raw AI SDK is ~0; its only measurable add-on here is **working
memory ≈ +200ms** (the autoLoad block injection + larger prompt).

**Why kuralle *could* be slow (none of these are in our config, so none fire):** `routes`
(router → a `generateObject` selection call, see `runtime/select.ts`), `refinementPolicies`
(pre-model input-refinement LLM call), `flows` with `decide` nodes, or `knowledge`/autoRetrieve
(RAG lookup). Kuralle's cost is **pay-for-what-you-use** — the base speaking agent is as fast as
the AI SDK. The bridge never buffers (yields each `text-delta` instantly; unit-tested + observed).

The voice-smoke turn-1 2.4–6.8s was **cold start** (first OpenAI connection + module init); the
bench's first warmup sample showed the same ~1.6s then settled to ~800ms. No latency follow-up is
needed for the kuralle backend itself — it meets the budget at the reasoner level.

## Cloudflare composition (Chunk C — design, grounded)

Both stacks already run on Workers. Two compositions exist; the clean one has **no extra hop**:

**A. Bridge-in-DO (recommended).** Syrinx's Workers Durable Object owns the voice pipeline
(Deepgram STT + Cartesia TTS over `createWorkersSocket`). Swap the single reasoner-construction
line in `packages/server-workers/src/live-session.ts:83`:
```ts
// from:
session.registerPlugin("bridge", new ReasoningBridge(fromStreamText({ model, ... })));
// to:
const runtime = createRuntime({
  agents: [defineAgent({ id, model: openai(env.OPENAI_MODEL), instructions, memory })],
  defaultAgentId: id,
  sessionStore: new MemoryStore(),                       // or a DO-storage-backed SessionStore
  defaultWorkingMemoryStore: new SqlPersistentMemoryStore(this.ctx.storage.sql), // DO SQLite → durable
});
session.registerPlugin("bridge", new ReasoningBridge(fromKuralleRuntime(runtime, { sessionId: conversationId })));
```
- The adapter is **pure** (no `node:` imports — only `@kuralle-syrinx/core`), so it bundles for
  Workers as-is. `@kuralle-syrinx/kuralle` adds nothing Node-only.
- `@kuralle-agents/core` runs on Workers (kuralle ships `@kuralle-agents/cf-agent` proving it);
  avoid the fs-backed stores (`FilePersistentMemoryStore`) — use `MemoryStore` /
  `SqlPersistentMemoryStore` (DO SQLite) instead.
- **Memory is durable across requests AND turns**: one DO per conversation, stable `sessionId`
  = the DO/conversation id; `SqlPersistentMemoryStore` persists working memory in DO SQLite
  exactly as kuralle's `examples-deploy/kuralle-memory-smoke` demonstrates.

**B. Two-DO / service binding.** Syrinx voice DO calls kuralle's `KuralleAgent` DO over its
`/chat` SSE endpoint. Bridges at the network boundary; adds a hop + SSE parse — only choose this
if kuralle agents must be deployed/owned separately. For latency (top priority), prefer A.

## Out of scope / not done
- No live Cloudflare deploy (the decisive memory proof is on the headless path; a CF deploy needs
  wrangler + DO bindings + a WS client driver — gold-plating beyond this goal). Wiring is grounded
  above and is a one-line swap + store choice.
- Barge-in ↔ kuralle-memory reconciliation: on barge-in Syrinx truncates ITS history to the
  spoken prefix, but kuralle already persisted the full assistant turn. Not exercised by this
  smoke; needed before production. Track alongside the latency follow-up.
