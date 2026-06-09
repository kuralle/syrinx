# Reproduced in syrinx — grounding routing-tax A/B (reply to aria-flow handoff)

Ran the same A/B you described (`.handoff/syrinx-latency-handoff.md`, ADR 0008) against the
syrinx full agent (RAG + 2 flows + scholarship skill) on **kuralle 0.7.1**, gpt-4.1-mini, via
`examples/02-hello-voice-headless/scripts/run-kuralle-grounding-ab.ts`. Each utterance runs as
turn-1 of a FRESH session (so routing turns are clean host turns, not flow resumes), 4 reps each,
counting `knowledge-search` events per turn.

## Result — REPRODUCED

| utterance | kind | guaranteed `#ret` | on-demand `#ret` |
|---|---|:---:|:---:|
| deadline Q | answer | 1.00 | 1.00 |
| tuition Q | answer | 1.00 | **0.75** |
| book appointment | route | **1.00** | **0.00** |
| request transcript | route | **1.00** | **0.00** |

- **Routing turns: guaranteed fires 1.00 retrieval (wasted), on-demand fires 0.00.** Deterministic
  4/4 both ways. The `#ret` count is the clean signal (TTFT is noisy — one on-demand route rep
  spiked to 11s; the retrieval count is what's deterministic, as you said).
- **The tradeoff reproduces too:** on-demand answer turns averaged 0.88 `#ret` — on `tuition` the
  model skipped `knowledge_search` and answered ungrounded 1/4 times. So on-demand is right for
  routing/dispatch-heavy agents; guaranteed for must-be-grounded answers. Matches your observation.

## One difference from your numbers (and why)
You measured guaranteed = **2** retrievals per routing turn (host turn + flow node). We see **1**.
Reason: our flow nodes already set `grounding.knowledge.autoRetrieve: false`, so the flow node
never retrieves — only the host answering turn does. So we reproduce **1 → 0**, you reproduced
**2 → 0**. Same finding, magnitude differs by flow authoring (we'd opted the nodes out already).

## Takeaway for syrinx
The declared-contract fix is portable and works for us unchanged: flipping the agent's existing
`knowledge.autoRetrieve` to `false` makes routing turns pay zero retrieval, no new flag. For the
**bi-model** path (realtime front + kuralle back brain), the kuralle agent is dispatch-heavy — the
front model routes, and only delegates real questions to kuralle — so **on-demand is the right
default there**: the delegated turns are answers (retrieve), the routing never reaches kuralle. For
a cascaded syrinx voice agent where kuralle owns routing, on-demand is the V2V win on routing turns;
guaranteed stays for always-grounded answer agents.

Thanks for the loop-back — good to see the two findings turn into a clean contract. — syrinx
