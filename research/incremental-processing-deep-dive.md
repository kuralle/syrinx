# Deep dive — preemptive generation is the rediscovery of incremental dialogue processing

> A rabbit-hole research synthesis: what the framework-level "preemptive/speculative generation" (Deepgram
> Flux eager-EOT, LiveKit preemptive, Pipecat markers, Syrinx hold/promote) actually *is* when traced to its
> academic roots — and the architectural "1" that falls out for Syrinx.
> Method: fable-sop discipline + /academic verification bar. Every source below confirmed to EXIST against a
> primary index (PNAS/PMC, Nature, ACL Anthology, Cambridge/BBS, arXiv). Claims are at abstract/title fidelity
> — pull exact numbers from the primary PDF before quoting formally. Date: 2026-07-09. INTERNAL research input.

## The thesis

Preemptive generation is not a clever engineering hack. It is the **engineering rediscovery of how humans
do turn-taking**, and the frameworks have independently reinvented ~40% of a model that was fully formalized
in 2009–2011 (the Incremental Unit model) and grounded in psycholinguistics stretching back decades. The
practical upshot for Syrinx: the features it has been building piecemeal — speculative generation, barge-in
truncation-to-heard-prefix, eager end-of-turn, preemptive TTS, the `contextId → turn-epoch` reshape — are all
instances of **one** primitive (incremental-unit add / commit / revoke). Adopting that primitive explicitly
collapses five features into one substrate.

## Layer 1 — The human science says turn-taking REQUIRES prediction

- **Stivers et al. (2009), "Universals and cultural variation in turn-taking in conversation," PNAS 106(26)**
  (PMC2705608). The modal gap between conversational turns is **~200 ms**, and this holds *universally* across
  ~10 typologically diverse languages. Turn-taking timing is a human universal, not a cultural artifact.
- **Levinson & Torreira (2015), "Timing in turn-taking and its implications for processing models of
  language," Frontiers in Psychology** (PMC4464110). States the puzzle directly: gaps are ~200 ms, but
  language *production* (planning + articulating even one word) takes on the order of **600 ms+**. The
  arithmetic is impossible unless the responder **starts planning before the speaker finishes** and
  **predicts when the turn will end.**
- **Bögels, Magyari & Levinson (2015), "Neural signatures of response planning occur midway through an
  incoming question in conversation," Scientific Reports 5:12881** (PubMed 26242909). EEG evidence: response
  *production planning* begins **within ~0.5 s of the point where the answer becomes retrievable** — i.e.
  mid-question, long before turn-end. **Bögels et al. (2020), "Neural correlates of turn-taking in the wild,"
  Cognition** (PubMed 32563734) confirms this in naturalistic free conversation.

**Read across:** humans natively do "eager generation" — plan the response *during* the incoming turn, hold
it, and launch at the *predicted* turn-end. Flux's `EagerEndOfTurn` → start drafting, `TurnResumed` → the
prediction was wrong → revise, is a mechanical transcription of this. The engineering stumbled onto the human
architecture.

## Layer 2 — The computational theory already formalized "start early + revise" (in 2009)

- **Schlangen & Skantze (2009 EACL / 2011 Dialogue & Discourse), "A General, Abstract Model of Incremental
  Dialogue Processing"** (ACL Anthology E09-1081; journals.uic.edu/dad/10712). The **Incremental Unit (IU)**
  model: processors consume and produce IUs; an IU can be **added** (a hypothesis), **committed** (locked in),
  or **revoked** (retracted when later input contradicts it). IUs are linked ("grounded-in") so a revision
  cascades through the network.
- **"Incremental Dialogue Management: Survey, Discussion, and Anticipation," arXiv:2501.00953 (2025)** — a
  current survey reconnecting incremental processing to the LLM era; evidence the field is live, not historical.

**The exact mapping (this is the key table):**

| Framework mechanism | IU-model operation |
|---|---|
| Flux `EagerEndOfTurn` | **add** a hypothesized end-of-turn IU |
| Flux `TurnResumed` | **revoke** it |
| Flux `EndOfTurn` (transcript guaranteed identical) | **commit** it |
| Syrinx `SpeculativeHold` (unpromoted) | uncommitted IU; buffered side effects |
| Syrinx `promote` / `discard` | **commit** / **revoke** |
| LiveKit `SpeechHandle(schedule_speech=False)` | uncommitted output IU |
| Barge-in truncation to **heard prefix** | **commit** what was heard, **revoke** what was not |

The frameworks implement a **degenerate** IU model: single-level, whole-turn granularity, binary
commit/revoke. The 2009 model is richer — partial commitment, sub-word revision, cascaded revocation through a
dependency network. **The frameworks discarded the fine-grained revision machinery.** That discard is both the
current ceiling and the opportunity.

## Layer 3 — Prediction-by-production: why one model can be predictor + responder

- **Pickering & Garrod (2013), "An integrated theory of language production and comprehension," Behavioral
  and Brain Sciences** (PubMed 23789620). Comprehenders predict upcoming input by **covertly running their own
  production system** (forward modeling) — you understand partly by predicting what *you* would say next.

**LLM connection:** an LLM is simultaneously a comprehension and a production model, so it can predict the
turn-end *and* the response in one system. That is the theoretical license for Pipecat's marker approach (the
LLM is both turn-judge and responder) and for "think-while-listening" full-duplex models. Prediction-by-
production says the human system is architected the same way — one generator doing both.

## Layer 4 — The output side (incremental TTS/NLG) is the half everyone skips

- **Baumann & Schlangen, "INPRO_iSS: A Component for Just-In-Time Incremental Speech Synthesis"**
  (ResearchGate 236879513) and **Buschmeier et al. (2012), "Combining Incremental Language Generation and
  Incremental Speech Synthesis for Adaptive Information Presentation," SIGDIAL** (ACM 2392800.2392852). Speech
  synthesis that starts before the full utterance is known and can **revise/adapt mid-utterance**.

The frameworks do incremental *input* (eager EOT) but mostly batch/sentence-level *output*. True
incrementality (per the IU model) is **symmetric** — incremental and revisable on both sides. Syrinx's
first-sentence segmenter is a crude incremental-output step; INPRO_iSS is the fuller vision. This is exactly
where the "preemptive TTS" steal (hold *synthesized audio*, not just `tts.text`) lives — pre-synthesizing a
held draft *is* incremental output with a commit/revoke gate.

## Layer 5 — The ambitious synthesis for Syrinx: adopt the IU model as the substrate

Whether or not the team framed it this way, `InteractionPolicy` + speculative generation + half-cascade +
barge-in truncation are **rebuilding the IU model on top of LLMs, one feature at a time.** The founder-altitude
move is to make it explicit: **Incremental Units flowing over the `PipelineBus` with first-class add / commit /
revoke semantics.** Consequences:

1. **Five features become one primitive.** Speculative hold/promote, eager-EOT `eos.interim`/`eos.retracted`,
   barge-in truncation, preemptive TTS, and turn boundaries are all add/commit/revoke on IUs. One mechanism,
   tested once.
2. **Barge-in truncation and speculative generation are the *same operation*.** Truncating conversation
   history to the *heard prefix* on interruption = "commit what was committed (heard), revoke the rest." A
   speculative draft that gets superseded = revoke. The `.understanding/` artifact's P0 cluster
   (`contextId = turn id`, `TtsPlayoutClock.positionMs` unused, heard-prefix truncation not wired) is, in IU
   terms, **a missing commit boundary.** The IU model is the principled resolution the artifact was groping
   toward with "add a generation-epoch."
3. **`contextId → turn-epoch` reshape becomes IU identity.** The reshape the InteractionPolicy and
   half-cascade RFCs both depend on is just: give each IU an identity and a commit state. Do it once, at the
   substrate, and both RFCs' turn-boundary problems dissolve.
4. **It grounds the engine in theory instead of vibes.** 50 years of turn-taking psycholinguistics
   (Stivers/Levinson) says *why* (prediction is mandatory); 15 years of incremental dialogue systems
   (Schlangen/Skantze) says *how* (add/commit/revoke); prediction-by-production (Pickering/Garrod) says *one
   model can do both*. Syrinx would be the first commercial voice engine to implement the IU model on LLMs
   explicitly — a defensible, citable architectural story, not a pile of latency hacks.

## What remains open / unproven (honesty)

- Every paper here is verified to exist; the numeric claims (200 ms gap, ~600 ms production floor, mid-question
  planning) are at abstract fidelity — confirm against the PDFs before quoting in an external doc.
- Whether a *fine-grained* (sub-turn, revisable) IU model buys measurable quality over the current degenerate
  whole-turn commit/revoke on *LLM* backends is unproven — LLMs are natively batch, and forcing token-level
  revisability may cost more than it saves. This is exactly what the InteractionPolicy RFC's eval harness
  should measure: degenerate vs fine-grained IU commit/revoke.
- The IU-substrate reframe is an architectural bet, not a validated result. It should be prototyped behind the
  existing seams (it is compatible with them — the seams already emit add/commit/revoke-shaped packets) before
  any wholesale reshape.

## Reading order for the maintainer
1. Levinson & Torreira 2015 (the "why prediction is mandatory" puzzle) — the motivating read.
2. Bögels 2015 (the EEG proof that humans plan mid-turn) — the killer evidence.
3. Schlangen & Skantze 2011 (the IU model) — the computational spine.
4. arXiv:2501.00953 (2025 survey) — the bridge to the LLM era.
