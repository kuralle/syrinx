# Literature Review — Model-Agnostic Full-Duplex Voice via Architectural Orchestration

> **Mode:** ARS `deep-research` / `lit-review` (annotated bibliography + synthesis / gap analysis).
> **Status:** INTERNAL research input for the Syrinx voice engine — a lit review / gap analysis, **not**
> a publishable manuscript. Produced with an AI research pipeline (ARS, CC-BY-NC): keep internal, do not
> ship as product copy.
> **Date:** 2026-07-09. **Verification rule applied:** every source below was confirmed against a primary
> index (arXiv / ACL Anthology / IEEE / ScienceDirect / publisher). Anything I could not confirm was
> dropped, not softened. Vendor blog posts are marked as such (Tier 3, non-peer-reviewed).

## Research question

To what extent can a **model-agnostic orchestration** — a small, swappable, *learned* turn-taking
controller (Voice Activity Projection–class), fed by a **rich-typed seam** (word timing + prosody, not
text-only), optionally with an open full-duplex model as the interaction "conductor," and reasoning
**delegated** to a separately swappable backend — match a **natively-trained end-to-end full-duplex**
model on turn-taking quality, backchannel timing, and latency? Where is the residual limit that only a
single joint audio-semantic representation can close?

**Scope.** In: turn-taking prediction models, full-duplex spoken-dialogue models, cascade-vs-E2E
architecture, interaction/reasoning decoupling, turn-taking evaluation. Out: TTS/STT acoustic modeling
per se, wake-word/VAD-only work, non-conversational speech.

**Method.** Keyword + Boolean search over arXiv, ACL Anthology, IEEE Xplore, ScienceDirect, and ACM DL
via a research-indexed web search, 2020–2026. Inclusion: primary sources with a resolvable identifier
and direct relevance to one of the five sub-areas. 22 sources retained.

---

## Annotated bibliography

### 1. Predictive turn-taking as a standalone, learned, portable model

- **Ekstedt & Skantze (2020), "TurnGPT: A Transformer-based Language Model for Predicting Turn-taking in
  Spoken Dialog."** EMNLP Findings 2020. arXiv:2010.10874. — *WHY/HOW/WHAT:* the text-side precursor — a
  transformer that incrementally predicts turn-shift points from words alone. Establishes turn-taking as a
  *separable prediction task* with its own model. Relevant as the "text signal" half of a rich seam.

- **Ekstedt & Skantze (2022), "Voice Activity Projection: Self-supervised Learning of Turn-taking
  Events."** Interspeech 2022. — *The anchor of the thesis.* A self-supervised, **frame-incremental** model
  that continuously predicts the *future* voice activity of both speakers over a short horizon from the raw
  waveform. It is small, real-time, and general (not tied to any one dialogue system). This is the concrete
  existence proof that "decide many times per second on the joint audio stream" is a standalone component,
  not a property only a giant fused model can have.

- **Inoue et al. (2024), "Multilingual Turn-taking Prediction Using Voice Activity Projection."**
  LREC-COLING 2024. arXiv:2403.06487. — VAP trained/evaluated across languages; turn-shift prediction
  transfers cross-lingually. Directly relevant to Syrinx's multilingual (e.g. Sinhala) motivation.

- **Inoue et al. (2025), "Prompt-Guided Turn-Taking Prediction."** SIGDIAL 2025 (ACL Anthology
  2025.sigdial-1.9). — Injects **textual prompt embeddings** into the VAP model, improving turn-taking
  prediction. Evidence that the controller *benefits from a richer-than-VAD seam* — i.e., fusing semantics
  into the timing model works. Supports the "rich-typed seam" claim.

- **"Yeah, Un, Oh: Continuous and Real-time Backchannel Prediction with Fine-tuning of Voice Activity
  Projection" (2024).** arXiv:2410.15929. — Fine-tunes VAP for **continuous, real-time backchannel timing**
  ("mhmm", "yeah"). Shows the same small controller predicts *when to backchannel*, not just when to take
  the turn — the exact GPT-Live "shows it's paying attention" behavior, as an orchestrated component.

- **"Voice Activity Projection Model with Multimodal Encoders" (2025)** (arXiv:2506.03980) and
  **"Predicting End-of-turn and Backchannel Based on Multimodal Voice Activity Projection"** (ACM DL
  10.1145/3716553.3750781). — Add pre-trained audio + face encoders; non-verbal features significantly
  improve turn-taking / backchannel prediction. Confirms the rich-seam direction generalizes beyond text to
  prosody/visual, and unifies end-of-turn + backchannel in one fine-tuned model.

- **"Triadic Multi-party Voice Activity Projection for Turn-taking Prediction" (2025).** arXiv:2507.07518.
  — Extends VAP to multi-party. Peripheral to Syrinx (dyadic) but shows the paradigm's active development.

- **"Applying General Turn-taking Models to Conversational Human-Robot Interaction" (2025).**
  arXiv:2501.08946 (HAI 2025; ACM DL 10.5555/3721488.3721593). — Applies TurnGPT **and** VAP, described as
  *general* turn-taking models, to a *different* system (an HRI robot) they were not built for. This is the
  single clearest evidence for **portability / swappability**: the learned controller is a reusable module
  dropped onto a new stack, exactly Syrinx's `InteractionPolicy`-seam premise.

### 2. Full-duplex end-to-end spoken-dialogue models (the counter-camp)

- **Défossez et al. (2024), "Moshi: a speech-text foundation model for real-time dialogue."**
  arXiv:2410.00037 (Kyutai). — Open, multi-stream speech-to-speech Transformer over the **Mimi** streaming
  neural codec, with an "inner monologue" (text tokens predicted alongside audio). Turn-taking is **learned
  end-to-end**: the model emits audio for both its own and the user's stream, so listen/speak overlap is
  intrinsic to the shared latent stream, not decided by an external module. The open reference point for
  "native TFD," and a candidate *conductor* for a hybrid.

- **MoshiRAG (Kyutai, 2026-04-30), "Asynchronous Knowledge Retrieval for Full-Duplex."** Vendor blog
  (Tier 3, not peer-reviewed). — Equips Moshi with **asynchronous** knowledge retrieval: it keeps
  conversing while a retrieval/reasoning step runs in the background. The open-source analog of the
  "keep-talking-while-delegating" pattern, on a native full-duplex model. Strongest evidence that
  delegation composes *with* full-duplex rather than being an alternative to it.

- **"FLM-Audio: Natural Monologues Improves Native Full-Duplex..." (2025).** arXiv:2509.02521. — Native
  full-duplex model; improves the "listen and speak simultaneously" behavior via a monologue training
  scheme. Part of the active native-TFD camp.

- **"BayLing-Duplex: Native Full-Duplex Speech Dialogue with a Single [autoregressive LLM]" (2026).**
  arXiv:2606.14528. — A **single** autoregressive LLM decides when to listen, when to speak. The direct
  *counter-thesis*: it bundles turn-taking into the generator rather than un-bundling it. Its existence and
  competitiveness mean the field has **not** converged on decoupling.

### 3. Voice-agent architecture taxonomy and the cascade-seam critique

- **Skantze (2021), "Turn-taking in Conversational Systems and Human-Robot Interaction: A Review."**
  *Computer Speech & Language* 67:101178. DOI 10.1016/j.csl.2020.101178. — Foundational review: end-of-turn
  detection, interruption handling, turn-taking cue generation. Frames turn-taking as a modeling problem
  independent of response generation — the conceptual basis for treating it as its own seam.

- **"A Survey of Full-Duplex Spoken Language Models" (2025).** arXiv:2509.14515. — Taxonomy of the field;
  defines **True Full-Duplex (TFD)** = simultaneous listen/speak with natural turn-taking, overlap, and
  backchannel. Useful for positioning cascade / turn-based-E2E / native-TFD / hybrid on one map.

- **"LLM-Enhanced Dialogue Management for Full-Duplex Spoken Dialogue" (2025).** arXiv:2502.14145. — *The
  strongest single validation of the Syrinx architecture.* Proposes a **semantic VAD module as a dialogue
  manager (DM)** that coordinates listen/speak/think for a full-duplex system built on an LLM. This is a
  dedicated, separable turn-taking controller driving a generator — precisely "un-bundle turn-taking into a
  controller." It exists and works as a research prototype.

- **"Chain-of-Thought Reasoning in Streaming Full-Duplex End-to-end..." (2025).** arXiv:2510.02066. —
  Reports that a streaming full-duplex **E2E** SpeechLM "struggles with semantic consistency" and adds
  explicit reasoning to compensate. Key evidence for the **residual-limit tradeoff**: native TFD pays for
  its joint stream with degraded reasoning — the exact weakness a delegated/decoupled design avoids.

### 4. Interaction-vs-reasoning decoupling / delegation

- **OpenAI (2026), "Introducing GPT-Live."** openai.com/index/introducing-gpt-live (Tier 3, vendor). — The
  motivating artifact. Two architectural changes: (a) full-duplex continuous interaction; (b) **delegation**
  — the interaction model keeps talking while a frontier model (GPT-5.5) reasons in the background, and the
  decoupling "allows GPT-Live to continuously use the latest models." Bundles both inside one closed model
  family. Reasoning-effort tiers (Instant/Medium/High) = swapping the delegated backend.

- **OpenAI (2025), "Introducing gpt-realtime" / "Advancing voice intelligence with new models in the
  API."** openai.com (Tier 3, vendor). — Prior generation: turn-based S2S with tool calls and background
  reasoning ("keeps the conversation moving while it reasons"). The commercial precedent for delegation.

- *(See also MoshiRAG, §2 — the open, peer-adjacent instance of delegation over full-duplex.)*

### 5. Evaluation — turn-taking quality and agentic voice tasks

- **Lin et al. (2025), "Full-Duplex-Bench: A Benchmark to Evaluate Full-duplex Spoken Dialogue Models on
  Turn-taking Capabilities."** arXiv:2503.04721; ASRU 2025 (IEEE 11433838). — First systematic benchmark of
  **interactive** behaviors: pause handling, backchanneling, turn-taking, interruption/takeover, latency.
  The referee for the "does the controller match native TFD on turn-taking" question.

- **"Full-Duplex-Bench-v2: A Multi-Turn Evaluation Framework..." (2025).** arXiv:2510.07838. — Extends to
  multi-turn, streaming-native evaluation.

- **"Evaluating Overlap Handling for Full-Duplex Speech Models" (2025).** arXiv:2507.23159. — Focused eval
  of simultaneous-speech / overlap handling — the hardest part of the residual gap.

- **Yao et al. (2024), "τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains."**
  arXiv:2406.12045 (Sierra). — The agentic-reasoning benchmark (text): multi-turn tool-use with a simulated
  user under domain rules. The task-success axis.

- **"τ²-Bench: Evaluating Conversational Agents in a Dual-Control Environment" (2025).** arXiv:2506.07982.
  — Extends τ-bench to dual-control (agent + user both act). Still text; no published voice variant.

---

## Synthesis — is the thesis supported?

**Verdict: the core thesis is well-supported by prior art on every claim *except* head-to-head superiority,
which no one — including OpenAI — has yet published.** Breaking it down:

**Proven.**
1. *Turn-taking is a separable, small, real-time, learned model.* VAP and TurnGPT are exactly this, and are
   explicitly described and *reused* as "general turn-taking models" on systems they were not built for
   (arXiv:2501.08946). Swappability is demonstrated, not hypothesized.
2. *The controller extends to backchannels and end-of-turn from the same small model* (arXiv:2410.15929;
   ACM 10.1145/3716553.3750781) — the "mhmm, I'm listening" behavior as an orchestrated component.
3. *A rich-typed seam helps.* Feeding the controller text prompts (SIGDIAL 2025) or audio+visual features
   (arXiv:2506.03980) measurably improves turn-taking over VAD-only input. "Don't bottleneck the seam
   through text" is empirically backed.
4. *A dedicated controller can drive a full-duplex generator.* arXiv:2502.14145 builds precisely this — a
   semantic-VAD dialogue manager coordinating a full-duplex LLM. The architecture is real, not notional.
5. *Delegation composes with continuous interaction, in the open.* MoshiRAG demonstrates async
   retrieval/reasoning behind a live full-duplex model; GPT-Live/gpt-realtime show the commercial version.

**Only approximated (supported in principle, not yet at Syrinx's operating point).** Every VAP-family
result above is measured in *research/HRI* settings, mostly offline or single-system, not inside a
production commercial cascade at an ~800 ms voice-to-voice budget on edge infrastructure. That the
components exist and hit their own metrics does **not** prove they compose to native-TFD quality at target
latency in a real product. That composition is unproven and is Syrinx's to demonstrate.

**Open / contested.**
6. *The field has not converged.* A live counter-camp (BayLing-Duplex, FLM-Audio, Moshi) bundles turn-taking
   *into* a single autoregressive generator. "Un-bundle" is a viable, well-supported bet — but it is one of
   two active architectures, not the settled winner. Any Syrinx positioning should treat native-TFD as a
   serious moving target, not a strawman.

**The residual limit, named.** A native TFD model processes incoming user audio and generates its own
response tokens **in one shared latent stream**, so paralinguistic input (prosody, hesitation, overlap,
timing) conditions *what* it says, continuously, not merely *when* it speaks. A controller-plus-generator
pipeline — even with a rich seam — hands a *compressed summary* (features/embeddings/decisions) across the
module boundary. It can make the *timing* decision as well as a native model (that is what VAP proves), but
it cannot make the generator's *semantic* choices continuously conditioned on the raw evolving audio the way
a shared stream does. **This is the one thing orchestration cannot fully recover.** Crucially, though, the
evidence shows it is a *two-way* tradeoff, not a one-sided deficit: the streaming-E2E-duplex model in
arXiv:2510.02066 "struggles with semantic consistency" and must bolt on explicit reasoning — i.e. the joint
stream is bought at the cost of reasoning quality, which is exactly what the decoupled/delegated design
protects. So the residual gap is real, bounded, and offset by a reasoning advantage on the other side.

**The most actionable gap for Syrinx — evaluation.** Turn-taking benchmarks exist (Full-Duplex-Bench v1/v2,
overlap-handling eval) and agentic-reasoning benchmarks exist (τ-bench, τ²-bench), but **no published
benchmark jointly measures turn-taking quality × agentic task success across architecture configurations**
(cascade+learned-controller vs native-TFD vs delegated-hybrid). OpenAI's "τ³-Voice-Telecom" is
vendor-internal and externally unverifiable — I could not confirm any independent "τ-voice" benchmark, and
it should not be cited as one. The exact number that would answer the RQ **has not been published by
anyone.** Running Full-Duplex-Bench × a voice adaptation of τ-bench across all three configs is therefore
both the way to prove Syrinx's thesis and an unclaimed contribution to the field.

## Limitations of this review

- Search was English-language, research-indexed web retrieval — not an exhaustive database export; recall is
  good but not PRISMA-complete. A handful of 2026 preprints (e.g. BayLing-Duplex, MoshiRAG) are very recent
  and lightly cited; their claims are as-reported, not yet independently replicated.
- Vendor sources (GPT-Live, gpt-realtime, MoshiRAG) are Tier 3 and self-reported; treated as evidence of
  *architecture and intent*, not of *measured superiority*.
- Quantitative specifics (exact VAP model size, latency, F1) were not extracted per-paper here; the claims
  above rest on abstracts/venue-level evidence. If a specific number is to be quoted in an RFC or eval plan,
  pull it from the primary PDF first.

## AI-assistance disclosure

This review was produced with an AI-assisted research pipeline (ARS `deep-research`, lit-review mode).
Sources were verified against primary indexes; unverifiable items were excluded. ARS outputs are CC-BY-NC —
this document is internal research input and must not be shipped as product/marketing text.
