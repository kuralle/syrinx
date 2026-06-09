# Full-fledged kuralle university agent — findings ("where we go")

One kuralle agent with **RAG + skills + two flows** + working memory, driven over a live
multi-turn TEXT harness (`smoke:kuralle-full-text`, gpt-4.1-mini, `text-embedding-3-small`).
All hard assertions pass with **no workaround** (manager removed cursor's
`__v2_pendingUserInput` clear — see "Flows" below). Numbers are from a manager-run.

## RAG (knowledge / autoRetrieve) — works well
- Per non-flow turn, `autoRetrieve` runs embed+vector-query automatically; emits
  `knowledge-search{latencyMs, resultCount}`. Observed **~300ms**, 5 results.
- Grounded correctly: T1 "March 31" deadline; T2 tuition/scholarship facts; answers cite corpus.
- Flow `reply` nodes set `grounding.knowledge.autoRetrieve:false` → no retrieval inside
  procedural steps (correct — you don't RAG mid-booking). Corpus ingest is a one-time ~1.6–2.5s.

## Skills (load_skill) — works
- T2: the model invoked `load_skill` for `scholarship-guidance`, then cited Dean's Merit (GPA≥3.5),
  FAFSA, and the Feb 15 deadline — i.e. it followed the skill body.
- Cost = an extra tool round-trip (~1s) + larger context, only on turns where the model loads it
  (no skill call on the plain T1 deadline question).

## Flows + host selector — works multi-turn, but authoring matters a lot
- **Host selector**: with ≥2 flows, every non-flow turn runs a `generateObject` triage
  (`enterFlow | route | keep`). Routing was correct: T1/T2 `keep` (Q&A), T3 `enterFlow`
  book-advisor-appointment, T6 `enterFlow` request-transcript. **This selector is an always-on
  ~1.5–2s tax on every keep turn** (T1 TTFT 2874ms with only 301ms of RAG).
- **Authoring pitfall (real bug we hit):** cursor's first version used the high-level
  `collect` + `confirmGate` nodes. That broke multi-turn: the `confirmGate` consumed the *same*
  user message the `collect` had already consumed → it booked **ADV-1 before the user confirmed**
  (confirm-gate skipped), and later turns went dead. Cursor papered over the deadness by deleting
  kuralle's `__v2_pendingUserInput` between turns — a workaround that itself corrupted flow resume.
- **Fix = kuralle's canonical pattern** (from its own restaurant-reservation/food-ordering
  examples): build flows from `reply` nodes that carry `tools` and a `next(turn)` which inspects
  `turn.toolResults`, looping on `'stay'` to wait for each user turn. Rebuilt both flows this way:
  collect-details (tool `record_booking_details`) → confirm (`'stay'` until the user confirms,
  then tool `create_booking`) → reply ref. Result: booking returns ADV-1 **only after real
  confirmation**, transcript returns TR-S12345 — all hard asserts pass, no workaround.
- **Voice quality caveat:** a node returning `{goto: next}` makes the next node ALSO generate in
  the same turn, so T4/T5 emitted 2–3 utterances concatenated in one turn. Fine for text; for
  voice TTS you want one utterance per turn (prefer `'stay'`-and-wait nodes, or suppress
  intermediate-node speech).

## Latency — the headline ("where we go")
| turn | mode | TTFT | total | notes |
|---|---|---|---|---|
| T1 RAG | keep | 2874ms | 3264ms | selector(~1.7s) + RAG(301ms) + gen |
| T2 RAG+skill | keep | 5832ms | 7294ms | selector + RAG + load_skill round-trip + gen |
| T3 enter booking | flow | 2240ms | 2450ms | selector enterFlow + collect ask |
| T4 give details | flow(resume) | 887ms | 5347ms | no selector (in-flow); multi-node chain |
| T5 confirm | flow(resume) | 995ms | 9971ms | create_booking + 3 node generations |
| T6 transcript | flow | 2560ms | 4439ms | enterFlow + tool + reply |

- Baseline bare reasoner is ~800ms TTFT (see kuralle-bridge-manager-notes.md). Full-featured turns
  are **3–10×** that. The costs stack: host-selector generateObject (keep turns), RAG embed+query,
  skill load round-trip, and multi-node flow chains (each node = a model call in the same turn).
- In-flow resume turns have low TTFT (~900ms) because `activeFlow` skips the selector — so the
  selector, not RAG/skills, is the dominant always-on cost.

## So: where do we go for production voice?
1. **Kill the per-turn LLM selector on the hot path** — use deterministic/keyword routing
   (`deterministicRouteMatch`) or an explicit intent trigger; reserve the generateObject selector
   for ambiguous cases. This is the single biggest voice-latency win.
2. **One utterance per turn in flows** — author with `'stay'`, avoid `{goto}` chains that speak twice.
3. **Run RAG retrieval in parallel with the selector**, and use a fast control model for selection.
4. **Use the canonical `reply`+tools+`'stay'` flow pattern**, not `collect`/`confirmGate`, until
   the latter's multi-turn input-consumption is fixed upstream.
RAG and skills are production-ready through the bridge today; flows work but need the authoring
discipline above, and the whole stack needs the selector fix to fit an ~800–1000ms voice budget.

---

## Update: re-run on @kuralle-agents/core 0.7.0 (derived host routing, ADR 0007)

0.7.0 removes the upfront per-turn host selector; an answering agent now folds
`enter_flow`/`transfer_to_agent` into its single speaking turn (ADR 0007 cites THIS file's
2874ms number as motivation). Bumped deps → typecheck + 6/6 unit tests + all hard asserts still
pass, **no code changes** (we never used routing.mode/always/default). Single-run numbers
(OpenAI jitter ±1s), gpt-4.1-mini:

| turn | mode | 0.6.1 TTFT | 0.7.0 TTFT | note |
|---|---|---|---|---|
| T1 RAG | keep | 2874 | 2996 | selector gone (RAG now starts at +216ms vs +2624ms) but single answering call carries folded tools + RAG ctx ⇒ ~same |
| T2 RAG+skill | keep | 5832 | 3230 | better — no separate pre-skill selector |
| T3 enter booking | flow | 2240 | 6017 | WORSE — routing rides a full answer call (`enter_flow` tool at +2702ms) + RAG fired on the entry turn + then flow-node gen |
| T4 details | flow-resume | 887 | 1957 | ~same (no selector either version) |
| T5 confirm | flow-resume | 995 | 994 | same |
| T6 transcript | flow | 2560 | 9078 | WORSE — enter_flow call + RAG + request_transcript + reply node chained |

**Honest read:**
- Structural change confirmed from traces: RAG now fires FIRST (+216ms, no upfront selector); flow
  entry shows `tool-call: enter_flow` folded into the speaking turn.
- The ADR's ~3× keep-turn win was measured on a BARE 2-flow agent (selector isolated). On a
  feature-rich agent (RAG autoRetrieve + skills + working memory), the removed selector is replaced
  by a heavier single answering call (host-control tools + skill tool + RAG context), so keep-turn
  TTFT is ~unchanged (~3s).
- **Flow-ENTRY turns regressed**: routing now costs a full speaking-model call to emit `enter_flow`
  (vs the old cheap structured classify), AND `autoRetrieve` now fires on the entry turn (wasted
  embed+query before the route decision), AND the flow node then generates ⇒ 6–9s.
- Net for voice: the keep-turn selector tax is genuinely gone, but kuralle-as-the-voice-loop is
  still ~3s+ (entry 6–9s). **The bi-model architecture (realtime front + kuralle as the delegated
  back brain) remains the right call** — 0.7.0 doesn't change that conclusion.
- Nit to flag upstream: autoRetrieve firing on flow-entry turns is wasted retrieval (the turn routes
  into a flow, never uses the RAG result).
