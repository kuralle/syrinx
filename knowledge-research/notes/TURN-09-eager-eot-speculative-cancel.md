---
id: TURN-09
title: Eager EOT — speculative reasoning on a medium-confidence end, cancel on resume
domain: TURN
tags: [eager-eot, speculative, predict-and-scrap, greedy-inference, cancel]
sources: [deepgram-ebook, vapi-pipeline-2]
code_refs: [pipecat/src/pipecat/services/cartesia/turns/stt.py:62, pipecat/src/pipecat/services/cartesia/turns/stt.py:164]
---

**Claim (one line):** Don't wait for certainty to start the LLM — fire speculatively on a *medium*-confidence end-of-turn, and silently scrap the attempt if the user resumes, hiding the latency of the high-confidence wait.

**Detail.** Deepgram Flux: **EagerEndOfTurn** is "medium confidence turn ending → begin speculative reasoning"; **TurnResumed** = "user continues → cancel speculative work"; only **EndOfTurn** (high confidence) finalizes (`deepgram-ebook` ~542-547). Because Flux keeps eager and final transcripts highly consistent, "speculative reasoning rarely diverges from the final text" (~550) — so most speculation is reused, not wasted. Vapi calls the same idea **greedy inference**: "when we think the user is done, immediately send their utterance to the LLM… if wrong and they continue, instantly cancel and restart with the complete updated utterance. **The user never hears the scrapped attempt**" (`vapi-pipeline-2` Problem #5). The clone wire-level form is Cartesia Ink-2's `turn.eager_end → turn.resume?` loop (`stt.py:62`), surfaced as `on_turn_eager_end` / `on_turn_resume` handlers (`stt.py:164-165`): eager_end is the cue to start the LLM, resume is the cue to abort it.

**Prior-art divergence.** Flux/Ink-2 give you an explicit *eager* event with its own threshold (`eager_eot_threshold`), separate from the final `eot_threshold` — two confidence tiers. Vapi's greedy inference is the framework-side equivalent built on top of a single endpointing decision (predict, start, scrap-on-continue). Pipecat's separate SmartTurn/LiveKit EOU models don't emit a two-tier eager event natively; speculation there is the framework's "preemptive generation" feature, not a turn-model signal.

**Implication for Syrinx.** Eager EOT is the single biggest latency win in turn-taking: it overlaps LLM TTFT with the high-confidence silence wait. Cost is wasted LLM tokens on resume — acceptable iff (a) the eager/final transcript divergence is low and (b) the scrapped audio never reaches the user's ears, which requires tight playback-cancel [[wiki/barge-map]]. Wire it to the eager event, not to a guess.

Links: [[TURN-04-flux-event-model]] [[TURN-03-semantic-vs-timeout-endpointing]] [[LAT-02-per-stage-metrics]] [[wiki/barge-map]] [[wiki/turn-map]]
