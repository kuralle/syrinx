# G6a — full kuralle agent cost (grounded, measured)

Per-turn OpenAI token usage captured via a `fetch`-wrapper on the agent's provider (handles the
Responses API `input_tokens`/`output_tokens` + embeddings + injects `stream_options.include_usage`).
gpt-4.1-mini, text-embedding-3-small, fresh session per turn. `scripts/run-kuralle-cost.ts`.

| turn | OpenAI calls | input tok | output tok | total | est $/turn |
|---|---|---|---|---|---|
| keep:deadline (RAG) | 2 (embed+answer) | 877 | 16 | 893 | $0.00038 |
| keep:scholarship (RAG+skill) | 3 (embed+answer+load_skill) | 1869 | 78 | 1947 | $0.00087 |
| flow-entry:book | 4 (embed+route+flow nodes) | 2557 | 115 | 2672 | $0.00121 |

Pricing **verified** (firecrawl → OpenAI / inworld): gpt-4.1-mini **$0.40/1M input, $1.60/1M output**
(cached input ~$0.10/1M).

## Read
- Full agent ≈ **0.9k–2.7k tokens/turn**; flow/skill turns cost **2–3×** a simple RAG turn (more
  internal model calls: embed + route + skill-load + flow nodes).
- ~**$0.001/turn** — tiny in $ on gpt-4.1-mini; the token COUNT matters more for caching/context.
- **Corroborates G3:** per-call chat prompts hover around/below the **1024-token** auto-cache
  threshold, so OpenAI prompt caching barely engages for this agent — the cost can't be shaved by
  caching at this prompt size (it'd help a larger-prompt / long-history agent).
