# For kuralle — provider prompt caching is implemented but UNWIRED by default (0.7.1)

Following the grounding A/B loop-back: while measuring caching on the syrinx side (Cloudflare AI
Gateway + OpenAI), we traced *why* nothing caches and it bottoms out in kuralle-core. Sharing with
file:line so you can decide if it's worth wiring (we think it's a bigger win than the gateway cache).

## TL;DR
kuralle-core ships full provider-prompt-cache support but **never calls it on the speaking turn**.
`streamText` is invoked with no `providerOptions`, so OpenAI `promptCacheKey` is never set and
Anthropic `cache_control` is never applied. The helpers + provider-detection exist; they're just
not wired. **Prompt structure is already cache-friendly** — so this is a pure wiring gap.

## Evidence (kuralle-agents @ 0.7.1, commit 9d7d213)
- `runtime/promptCache.ts` implements both:
  - `applyAnthropicCacheControl(messages, ttl)` — `system_and_3` ephemeral breakpoints.
  - `buildOpenAIResponsesProviderOptions({ useSessionAsPromptCacheKey, truncationFallback }, sessionId)`
    → `{ promptCacheKey: sessionId, truncation }`.
  - plus detectors `isAnthropicLanguageModel()` / `isOpenAIResponsesModel()`.
- **Zero callers** of those helpers anywhere in shipped src (only the file itself + tests). They are
  **not exported** from `kuralle-core`'s `index.ts` — consumers can't reach them either.
- The two real `streamText` calls pass **no `providerOptions`**:
  - `runtime/channels/TextDriver.ts:77` — `streamText({ model, system, messages, tools, abortSignal })`
  - `runtime/channels/extractionTurn.ts:39` — same shape.
- Prompt assembly is **cache-friendly** (`TextDriver.ts:60-66`): `system = composeSystem(baseInstructions,
  …, workingMemoryPrompt)` then `appendGatherBlocks(…, [retrievalBlock, memoryBlock])` — static
  instructions first, volatile RAG/working-memory appended last, history appended after. Correct order;
  nothing volatile (timestamp/uuid/random) in the prefix.

## Consequence (by provider)
- **OpenAI:** falls back to the *automatic* prefix cache only. Works without a key, but (a) needs a
  **≥1024-token stable prefix** — small agents sit under it and cache nothing; (b) no `promptCacheKey`
  ⇒ lower hit-rate across load-balanced / multi-isolate routing (the key pins same-session turns to the
  same cache slot).
- **Anthropic (Claude):** caching is **opt-in — you MUST set `cache_control`**. Unwired ⇒ **0% caching ⇒
  full input price + latency on every turn.** For a Claude voice/chat agent this is the big one (~up to
  75% input-cost + a real TTFT chunk per multi-turn turn).

## Suggested fix (small, the pieces already exist)
In `TextDriver` (and `extractionTurn`), build `providerOptions` by default and pass to `streamText`:
```ts
const providerOptions = {};
if (isAnthropicLanguageModel(model)) {
  messages = applyAnthropicCacheControl(messages, /* ttl */ '5m'); // also breakpoint the system msg
}
const oa = isOpenAIResponsesModel(model)
  ? buildOpenAIResponsesProviderOptions({ useSessionAsPromptCacheKey: true, truncationFallback: 'auto' }, ctx.session.id)
  : null;
if (oa) providerOptions.openai = oa;
streamText({ model, system, messages, tools, abortSignal, providerOptions });
```
Gate by the existing detectors so non-matching providers are untouched. Export the helpers from the
index so SDK consumers can opt a custom driver in too. Default-on is safe (both are no-ops on providers
that ignore the fields, and the detectors are conservative).

## Why this beats the gateway cache (what we measured on our side)
- Cloudflare AI Gateway response-cache is **off by default** and only hits on **byte-identical** requests
  — a stateful RAG/memory/multi-turn agent's prompt differs each turn, so it only helps repeated
  identical FAQ queries. (Verified via `cf-aig-cache-status`: default MISS/MISS; HIT only with
  `cf-aig-cache-ttl`.)
- Provider **prompt caching** caches the stable *prefix* and so helps **every multi-turn session** — the
  common case. It's the higher-leverage fix, and kuralle already has the code.

— syrinx
