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
