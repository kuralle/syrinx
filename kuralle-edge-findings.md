# kuralle-edge spike — findings

Full kuralle university agent (RAG + flows + skills, InMemory vector store) deployed on
Cloudflare Workers. Model: gpt-4.1-mini, embedder: text-embedding-3-small.

## Deployed URL

https://kuralle-edge-spike.mithushancj.workers.dev

## Bundle

| metric | value |
|---|---|
| Total upload | 1819.02 KiB |
| gzip | 306.36 KiB |
| Worker startup time | 42 ms |
| nodejs_compat | **works** — no bundling failures, no `node:` import errors |

The full `@kuralle-agents/core` + `rag` + `skills` stack bundles cleanly on Workers with
`nodejs_compat`. No Vectorize, no Durable Objects.

## Edge TTFT measurements (server-side `meta` event)

Question: *"What is the application deadline for the computer science masters?"*
Answer contains **March 31** on all Q&A runs (verified).

| run | type | ttftMs | ingestMs | cold | totalMs | notes |
|---|---|---|---|---|---|---|
| 1 | **COLD Q&A** | **2105** | **3585** | true | 2419 | first request after deploy; ingest + run |
| 2 | WARM Q&A | 1169 | 0 | false | 1711 | same isolate (primed) |
| 3 | WARM Q&A | 1096 | 0 | false | 1507 | same isolate |
| 4 | WARM Q&A | 1045 | 0 | false | 1276 | same isolate |
| 5 | **FLOW ENTRY** | **4591** | 0 | false | 5133 | *"I'd like to book an advisor appointment"* |

**Cold wall-clock to first token** ≈ ingestMs + ttftMs = 3585 + 2105 ≈ **5690 ms** (ingest
happens before `runStart`; `ttftMs` is post-ingest only).

## vs local Node (from kuralle-full-findings.md, @kuralle-agents/core 0.7.0)

| scenario | local TTFT | edge TTFT | delta |
|---|---|---|---|
| Q&A (keep/RAG) | ~2996 ms | ~1045–1169 ms warm | **edge ~2× faster** on warm isolate |
| Q&A cold (incl ingest) | ~2996 ms (ingest separate ~1.6–2.5s) | ~5690 ms wall | edge cold slower (edge ingest ~3.6s) |
| Flow entry | ~6017 ms | ~4591 ms | **edge ~1.3× faster** |

## Surprises

1. **Multi-isolate cold starts**: sequential curls often hit different isolates (`cold:true`
   with fresh `ingestMs`). True warm numbers require priming the same isolate first.
2. **Ingest on edge ~3.6s** vs ~1.6–2.5s local — embedMany for 4-doc corpus is slower at
   the edge (CPU/network to OpenAI embeddings API from CF POP).
3. **Warm Q&A ~1–1.2s TTFT** beats local ~3s — likely CF→OpenAI routing is closer than
   dev machine, and no local process overhead.
4. **Initial 404 (CF error 1042)** right after deploy resolved within ~30s — propagation lag.
5. **Flow entry ~4.6s** is better than local ~6s but still far above voice budget; routing
   + RAG-on-entry + flow-node generation stack identically on edge.

## Conclusion

The full kuralle stack (core + rag + skills, InMemory RAG, two flows, scholarship skill)
**bundles and runs on Cloudflare Workers** with `nodejs_compat`. Edge warm Q&A TTFT is
~1s (vs ~3s local); cold first-token is ~5.7s wall (ingest dominates). Flow entry ~4.6s.
Vectorize (Phase 2) would eliminate per-isolate ingest on cold starts.

---

## Phase 2 — Vectorize

Full kuralle university agent (RAG + flows + skills) on a **new** Worker
(`apps/kuralle-edge-vectorize`) backed by **Cloudflare Vectorize** persistent
index `kuralle-university-kb`. Corpus ingested once via `POST /ingest`; no
per-request ingest on `/chat`.

### Deployed URL

https://kuralle-edge-vectorize.mithushancj.workers.dev

### Bundle

| metric | value |
|---|---|
| Total upload | 1993.82 KiB |
| gzip | 321.00 KiB |
| Worker startup time | 82 ms |
| VECTORIZE binding | `kuralle-university-kb` (1536 dims, cosine) |

### Ingest (one-time)

```json
{"ingested":7,"ms":3917}
```

Vectorize upserts are **async** — vectors become queryable ~60–90s after upsert
(`processedUpToMutation` must advance). `/ingest` should be followed by a wait
before first `/chat`.

### Edge TTFT measurements (server-side `meta` event)

Question: *"What is the application deadline for the computer science masters?"*
Answer contains **March 31** on all Q&A runs (verified, grounded from Vectorize).

| run | type | ttftMs | ingestMs | cold | totalMs | notes |
|---|---|---|---|---|---|---|
| 1 | **COLD Q&A** | **2388** | — | true | 2423 | no per-request ingest |
| 2 | COLD Q&A | 1915 | — | true | 3010 | different isolate |
| 3 | COLD Q&A | 1736 | — | true | 1994 | different isolate |
| 4 | COLD Q&A | 1608 | — | true | 1988 | different isolate |
| 5 | COLD Q&A | 2263 | — | true | 2531 | different isolate |
| 6 | **FLOW ENTRY** | **4970** | — | true | 6313 | *"I'd like to book an advisor appointment"* |

All cold runs: `ingestMs` absent (no per-isolate corpus embed). TTFT is
end-to-end first token only.

### A/B: InMemory (Phase 1) vs Vectorize (Phase 2)

| scenario | InMemory (Phase 1) | Vectorize (Phase 2) | verdict |
|---|---|---|---|
| Cold Q&A wall to first token | ~5690 ms (ingest 3585 + ttft 2105) | ~1608–2388 ms | **Vectorize ~2.4–3.5× faster** |
| Cold Q&A ttftMs only | 2105 ms (+ hidden ingest) | 1608–2388 ms | Comparable TTFT, **no ingest tax** |
| Warm Q&A ttftMs | 1045–1169 ms | (not isolated — all runs cold) | Phase 1 warm still ~1s |
| Flow entry ttftMs | 4591 ms | 4970 ms | ~same |
| Per-isolate ingest | **yes** (~0.6–3.6s every cold isolate) | **no** (pre-populated index) | **Vectorize removes ingest tax** |

### Phase 2 surprises

1. **Async Vectorize mutations**: `wrangler vectorize info` shows `vectorCount: 0`
   immediately after upsert; vectors appear after ~60–90s. Must wait before querying.
2. **New describe API**: binding returns `vectorCount` (not `vectorsCount`).
3. **Metadata mapping**: chunk text in `_document` + `sourceDocId` per
   `CloudflareVectorizeStore` contract — retrieval works once index is consistent.
4. **Cold TTFT variance** (1.6–2.4s) is isolate/routing noise, not ingest — all runs
   grounded on March 31 without re-embedding corpus.

### Phase 2 conclusion

**Vectorize removes the per-isolate ingest tax.** Phase 1 cold wall-clock was
~5.7s (dominated by ~3.6s embed-on-every-cold-isolate); Phase 2 cold TTFT is
~1.6–2.4s with persistent RAG. One-time `/ingest` (~4s) + ~90s consistency wait
replaces repeated per-isolate ingest. Flow entry unchanged (~5s).

---

## Verified A/B (manager curls against both LIVE workers)

Both deployments curled independently by the manager (not worker self-report).

| | InMemory (`kuralle-edge-spike`) | Vectorize (`kuralle-edge-vectorize`) |
|---|---|---|
| Bundles on Workers (nodejs_compat) | ✅ 1.82 MiB / 306 KiB gz | ✅ 1.99 MiB / 321 KiB gz |
| Corpus ingest | **per cold isolate** (0.6–3.6s each) | **once** (7 chunks, persistent) |
| Cold-isolate TTFT (manager runs) | ttft ~1.1–2.1s **+ ingest 0.6–3.6s** = wall ~2.7–5.7s, variable | **1522 / 1695 / 1726 / 2113 ms** — no ingest, consistent |
| Warm (primed isolate) TTFT | ~1.0–1.2s | ~1.0–1.5s (+ small Vectorize query hop) |
| Grounding | March 31 ✓ | March 31 ✓ + scholarships/Feb 15 ✓ (from Vectorize) |
| Flow-entry TTFT | ~4.6s | ~5.0s |

**Verdict:** Vectorize removes the per-isolate re-embed tax → cold-start TTFT becomes
**consistent ~1.5–2.1s** (model call + one Vectorize query hop), ~2–3.5s faster than InMemory's
variable cold wall-clock. For any real edge deployment, Vectorize is the choice (InMemory's
per-isolate ingest is disqualifying at scale). Operational note: Vectorize upserts are eventually
consistent (~60–90s to become queryable) — ingest is an out-of-band step, not per-request.

**Still ~1.5–2.1s for Q&A, ~5s flow-entry** — above an ~800–1000ms voice budget even on the edge,
because the cost is the OpenAI round-trip(s), which the edge doesn't shrink. Confirms the standing
conclusion: kuralle = the delegated **back brain** behind a realtime front (bi-model), not the
voice loop itself.

---

## Phase 3 — AI Gateway

Full kuralle university agent on a **new** Worker (`apps/kuralle-edge-aigateway`) with the same
Vectorize binding (`kuralle-university-kb`) but OpenAI chat + embeddings routed through
**Cloudflare AI Gateway** (`kuralle-gateway`) via `createOpenAI` + gateway `baseURL` +
`cf-aig-authorization` header (Vercel AI SDK, CF-recommended pattern).

### Deployed URL

https://kuralle-edge-aigateway.mithushancj.workers.dev

### Bundle

| metric | value |
|---|---|
| Total upload | 1996.89 KiB |
| gzip | 321.49 KiB |
| Worker startup time | 63 ms |
| VECTORIZE binding | `kuralle-university-kb` (reused, no re-ingest) |
| Secrets | `OPENAI_API_KEY`, `CF_AIG_TOKEN` |

### Edge TTFT measurements (server-side `meta` event)

Grounding verified: deadline answer contains **March 31** on all Q&A runs.

#### Cache-miss (4 distinct questions — fresh gateway/model path each)

| run | question | ttftMs | totalMs | cold |
|---|---|---|---|---|
| 1 | application deadline (CS masters) | **5508** | 5848 | true |
| 2 | in-state tuition | **1976** | 2335 | true |
| 3 | scholarships + requirements | **6156** | 7178 | true |
| 4 | CS masters prerequisites | **2472** | 3034 | true |

Range **1976–6156 ms**, median **~3990 ms**.

#### Cache-hit (same deadline question ×3 — AI Gateway response cache)

| run | ttftMs | totalMs | cold | notes |
|---|---|---|---|---|
| 1 | **420** | 420 | true | gateway cache hit |
| 2 | **454** | 454 | true | gateway cache hit |
| 3 | **814** | 814 | true | gateway cache hit |

**~5–13× faster** than cache-miss on the same question. Caching kicks in from run 1
(repeat identical prompt after miss-1 populated gateway cache).

#### Flow entry

| run | ttftMs | totalMs | cold |
|---|---|---|---|
| *"I'd like to book an advisor appointment"* | **4574** | 4810 | false |

### A/B: Direct Vectorize (Phase 2) vs AI Gateway (Phase 3)

Manager curls against both LIVE workers, same questions, same session.

| scenario | Direct Vectorize | AI Gateway | delta |
|---|---|---|---|
| Cache-miss deadline | 1364 ms | 5508 ms | gateway **+4.1s** (first cold) |
| Cache-miss tuition | 1312 ms | 1976 ms | gateway **+0.7s** |
| Cache-miss scholarships | 3448 ms | 6156 ms | gateway **+2.7s** |
| Cache-miss prerequisites | 1070 ms | 2472 ms | gateway **+1.4s** |
| Cache-miss median | **~1312 ms** | **~3990 ms** | gateway **~3× slower** on miss |
| Cache-hit deadline (×3) | 1106–1565 ms | **420–814 ms** | gateway **~2–3× faster** with cache |
| Flow entry | 4350 ms | 4574 ms | ~same |

### Phase 3 conclusion

**Gateway adds latency on cache-miss** (~1.4–4.1s extra vs direct OpenAI, median ~3× slower) —
the extra hop (Worker → Gateway → OpenAI) plus gateway processing dominates. Embedding +
chat both traverse the gateway.

**Gateway caching helps dramatically on repeat prompts**: identical deadline question drops
from ~5.5s (miss) to **420–814 ms** (hit) — below direct Vectorize warm (~1.1–1.6s). For
high-repeat queries (FAQ, common intents), gateway cache can beat direct OpenAI.

**Trade-off**: use AI Gateway when you need observability, rate limiting, caching of repeated
prompts, or unified routing — accept ~2–4s TTFT penalty on novel queries. For voice Q&A with
mostly unique utterances, **direct OpenAI (Phase 2) is faster**; for FAQ-heavy workloads with
repeated phrasing, **gateway cache-hit (~0.4–0.8s) is competitive**.

Flow entry unchanged (~4.5–4.6s) — routing layer doesn't change flow-routing cost.

### Manager-verified (independent curls) + honest read
My own runs reproduce the shape:
- **cache-miss**: 1195 / 1574 / 4941 ms (cursor: 1976–6156). HIGH variance — some misses ~1.2–1.6s
  (comparable to direct ~1.3s), others spike to ~5–6s on cold isolates + the proxy hop. So the
  gateway is **noisier and on-median somewhat slower on miss, NOT a reliable +2.7s** — the "3×
  slower" is median-pulled-by-cold; a warm miss is close to direct.
- **cache-hit**: best hit **485 ms** (cursor: 420–814) — a real ~2–3× win vs direct. BUT hits need
  an IDENTICAL upstream prompt: in run 3 the same /chat repeated MISSED (1495 ms) because the
  kuralle agent's prompt carries session/working-memory context that **changes across turns** →
  no cache key match. So caching helps **repeated identical FAQ queries from fresh sessions**, not
  multi-turn conversations.

**Verdict:** the CF AI Gateway is **not a live-path latency win** for a stateful RAG/memory voice
agent (proxy hop adds variance; cache rarely hits because prompts differ per turn). Its real value
here is **caching common FAQ queries** (~450ms vs ~1.3s) plus observability / rate-limiting / cost
control / unified keys — operational, not latency. For the bi-model back brain, route through the
gateway for the **logging/cost** benefits, but don't expect it to cut TTFT.

### CORRECTION — Cloudflare AI Gateway does NOT cache by default (verified via cf-aig-cache-status)
Researched the CF docs (Context7 + developers.cloudflare.com/ai-gateway/features/caching) and proved
it on the wire against kuralle-gateway with the `cf-aig-cache-status` response header:
- **Default (no `cf-aig-cache-ttl`), identical request ×2 → MISS, MISS.** Caching is **OPT-IN / OFF by
  default**. Enable via the dashboard "Cache Responses" toggle OR per-request `cf-aig-cache-ttl`.
- **With `cf-aig-cache-ttl:600` → HIT.** Caching works once opted in — and (contra the doc's "text/image
  only" note) **streaming also cached**: streaming ×2 gave MISS → HIT.
- **Our worker sent NO `cf-aig-cache-ttl` and the gateway default is off → it got ZERO gateway caching.**
  So the earlier Phase-3 "cache-hit ~450–815ms" numbers were **misattributed** — they were NOT gateway
  cache hits (proven: default off + no ttl header). They were OpenAI latency variance / warm-isolate
  effects. The gateway added a proxy hop and **no caching** on our setup.

**To actually use gateway caching:** send `cf-aig-cache-ttl` (or flip the dashboard toggle). But it only
helps **repeated identical requests** — a stateful RAG/memory/multi-turn agent's prompts differ each
turn, so real hits are limited to identical FAQ queries. Net unchanged: gateway = observability/cost/
rate-limit + optional FAQ caching, not a live-path latency win.

### Phase 3b — caching turned ON (cf-aig-cache-ttl) + proven via cf-aig-cache-status
Added `cf-aig-cache-ttl: 600` to the worker's gateway provider and surfaced `cf-aig-cache-status`
in the SSE meta. Redeployed. Same worker, real curls:

| run | question | ttftMs | cf-aig-cache-status |
|---|---|---|---|
| 1 | deadline | 5215 | **MISS** (populates) |
| 2 | deadline (identical) | **470** | **HIT** |
| 3 | deadline (identical) | **474** | **HIT** |
| 4 | tuition (distinct) | 2005 | MISS |

- With ttl, identical requests HIT at **~470 ms** (vs ~2–5s MISS) — a real **~4–11× win**, now PROVEN
  by the cache-status header (not inferred). Distinct questions MISS (full model latency).
- Retroactively confirms the earlier correction: the original worker sent NO ttl → gateway MISSed →
  the prior "485ms hits" were NOT gateway cache. Genuine HITs only appear once caching is enabled.
- **Scope of the win:** only IDENTICAL requests hit. A multi-turn / varied-prompt agent rarely
  produces identical upstream requests, so this helps **repeated identical FAQ queries** (e.g. many
  fresh users asking the exact deadline) — not conversations. Confirms the verdict: gateway cache is
  an FAQ/cost/observability layer, not a multi-turn latency fix. Provider prompt caching
  (kuralle-prompt-cache-finding.md) remains the lever that helps every multi-turn session.
