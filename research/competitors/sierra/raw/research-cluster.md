# Sierra.ai — RESEARCH / BENCHMARKS / EVALUATION / SEARCH cluster

Competitive study for Syrinx (voice-AI infrastructure). All 11 URLs fetched live via firecrawl (HTTP 200, full content). Dates and authors are as shown on-page (Sierra back-dates `modifiedTime` site-wide to 2026-05-12; `publishedTime` is the real publish date).

The Tau "cinematic universe": **𝜏-bench** (2024, foundational tool-agent-user) → **𝜏²-bench** (2025, dual-control/collaborative) → **𝜏-bench leaderboard** (2025, transparency layer) → **𝜏³-Bench** (2026, umbrella release adding **𝜏-Knowledge** + **𝜏-Voice**). Adjacent: **μ-Bench** (multilingual ASR), **𝜏-voice** (standalone voice benchmark, linked but not in this cluster). Product/eval side: **Simulations** (Agent OS), **Linnaeus + Darwin** (in-house search models), **golden-dataset search eval**, **Expert Answers** (knowledge loop).

---

### 𝜏-Bench: Benchmarking AI agents for the real-world — benchmarking-ai-agents
- **Date/author**: June 20, 2024. Sierra AI research team. Paper: arXiv 2406.12045; code: github.com/sierra-research/tau-bench.
- **Thesis**: There is a dearth of benchmarks measuring agent *reliability* in dynamic, human-in-the-loop scenarios; 𝜏-bench (tool-agent-user) tests agents on completing complex tasks while interacting with LLM-simulated users and programmatic tools, and reveals that simple LLM agents (function-calling / ReAct) fail even relatively simple tasks.
- **Technical specifics**:
  - **Three design requirements** distilled from production: (1) interact with **both** humans and programmatic APIs over long horizons; (2) accurately follow complex domain-specific policies/rules; (3) maintain consistency/reliability "across millions of interactions."
  - **Framework = three modular pieces**: (1) realistic databases + tool APIs; (2) domain-specific policy documents dictating required agent behavior; (3) an LLM-based user simulator guided by natural-language instructions for diverse scenarios.
  - **Evaluation = stateful**: compares database state after task completion vs expected outcome → objective, no human/LLM grading needed; tolerant of conversational variation.
  - **New metric pass^k**: measures whether agent can complete the *same* task across k trials (reliability), distinct from pass@k.
  - **Construction in 3 stages**: (1) manually designed DB schema, APIs, policies from real customer-support use cases; (2) used **GPT-4** to generate code snippets producing data entries at scale; (3) manually generated user-sim scenarios + target goal state, verified correctness before inclusion.
  - **Two domains**: 𝜏-retail and 𝜏-airline.
  - **Models tested**: 12 popular LLMs (proprietary + open). Best agent = **GPT-4o**, achieving **<50% average success** across the two domains. Llama3-70B used ReAct; others used function calling (ReAct gave no significant improvement).
  - **Reliability finding**: GPT-4o drops to **~25% on pass^8 in 𝜏-retail** — a "staggering 60% drop" vs its pass^1. Practical meaning: only 25% chance of resolving 8 instances of the same issue across different customers.
  - **Failure analysis**: broken into four quadrants; function-calling agents are "not great at following rules provided in the policy documents." Key challenges: consistent rule-following, long-horizon planning, focusing on the right info amid conflicting facts.
  - Sierra's own agents add: declarative Agent SDK, supervisory LM models, Agent Development Life Cycle.
- **Verbatim quotes**:
  - "𝜏-bench's focus on evaluating agents on goal database state (as opposed to evaluating the conversation itself) allows for fast and faithful assessment of agent capabilities, alleviating the need for any human or LLM-based evaluation."
  - "the agent powered by GPT-4o drops to ~25% on pass^8 in 𝜏-retail, which is a staggering 60% drop compared to its corresponding pass^1 score."
  - "agents must maintain consistency and reliability at scale, across millions of interactions."
- **→ Syrinx implication**: The reliability bar is pass^k, not pass^1 — a Syrinx voice agent must resolve the *same* task repeatably. Stateful DB-diff scoring is the gold standard to copy for any internal eval (avoids LLM-judge noise).

---

### 𝜏-bench is shaping the development and evaluation of agents — tau-bench-shaping-development-evaluation-agents
- **Date/author**: March 18, 2025. Sierra research team.
- **Thesis**: One year on, 𝜏-bench has become a cornerstone of agent evaluation across academia and industry; the pass^k reliability metric is reshaping how labs measure agents.
- **Technical specifics**:
  - Restates early result: GPT-4-based agents succeeded in <50% of tasks; **~25% success when repeating the same task eight times**.
  - **Academic adoption**: MedAgentBench (medical/EMR, FHIR APIs, physician-written scenarios, cites 𝜏-bench as exemplar); LAM Simulator (ICLR 2025, "Large Action Model Simulator," criticizes 𝜏-bench's coverage of only 2 domains retail+airline); listed alongside WebShop, WebArena, AgentBench, SWE-Bench; cited in a Berkeley LLM-training report.
  - **Industry adoption**: Anthropic — Claude 3.5 Sonnet claimed SOTA on 𝜏-bench (late 2024); Claude 3.7 new top performer; Anthropic model cards now discuss the **pass^k reliability metric** introduced by 𝜏-bench. Scaled Cognition used it for agent foundation models.
  - **Performance trend**: from initial <50%, best models now crossing **80% pass^1 in the easier domain (retail)**; pass^k still degrades sharply (notable drop by k=8).
  - Anthropic adapted minimal "SWE-Agent" scaffold to 𝜏-bench; Claude 3.5 scored high without heavy prompt engineering. Extended thinking / self-reflection / longer chain-of-thought used to boost pass^k consistency.
  - Mentions legal AI (LegalAgentBench) building on the template.
  - Open call: email research@sierra.ai for improvements.
- **Verbatim quotes**:
  - "Unlike traditional benchmarks, 𝜏-bench doesn't just test whether an agent can complete a task once; it measures whether it can do so consistently multiple times."
  - "𝜏-bench's pass^k metric exposed how even strong models degrade over multiple attempts."
  - "the best models are now crossing 80% pass^1 in the easier domain (retail). However, even the most capable agents still fail on several tasks and struggle with consistent reliability across multiple runs."
- **→ Syrinx implication**: pass^k has become an industry-recognized lexicon; Syrinx should report voice-agent reliability in pass^k terms to be legible to model-lab customers. The 80% pass^1 ceiling in text retail is the bar voice has to chase.

---

### 𝜏²-bench: benchmarking agents in collaborative real-world scenarios — benchmarking-agents-in-collaborative-real-world-scenarios
- **Date/author**: June 10, 2025. Sierra research team. Paper: arXiv 2506.07982; code: github.com/sierra-research/tau2-bench.
- **Thesis**: Real tasks rarely give the agent full control of the environment ("dual control" — e.g. tech support where the user must reboot their own phone); 𝜏²-bench adds a shared action space so agents must coordinate, guide, and assist a user toward a shared objective.
- **Technical specifics**:
  - **New domain: telecom troubleshooting** (broken data connections, MMS issues, switching mobile network modes).
  - **Two operating modes**: **Solo mode** (agent has full control, performs all actions) vs **Interactive mode** (agent guides user through their responsibilities while managing its own tools). Environment is **co-owned** — agent toggles backend features/queries network settings; user verifies on-device status, reboots hardware, changes configs.
  - **Headline result**: a drop of **up to 25 points** in task success when moving solo→interactive, even on top-tier LLMs (**GPT-4.1**, **o4-mini** named).
  - **Compositional task generator**: tasks built from a library of small verifiable **atomic actions** ("toggle mobile data," "check data limit," "adjust network mode") — mix-and-match for systematic control of task complexity; replaces manual scenario writing; every task auto-verifiable via measurable environment footprint (state change, flag update, resolved error).
  - **Upgraded user simulators**: tightly coupled to environment, constrained by available tools + observable state (won't invent nonexistent device settings or make contradictory network-status claims). **Full audit of simulators across ALL domains** including original Airline + Retail — surfaced failure modes like premature conversation termination and missing constraints, then patched.
  - Future directions named: multi-user collaboration, interaction-sensitive reward functions (reward smoothness/politeness/efficiency not just success), human-in-the-loop training, new domains (healthcare, legal, education).
- **Verbatim quotes**:
  - "This is the world of dual control, and it's where 𝜏²-bench comes in."
  - "A drop of up to 25 points in task success rate when agents moved from solo to interactive mode, even those built on top-tier LLMs, such as GPT-4.1 and o4-mini."
  - "It's not enough to say, 'Turn on data roaming'—the agent must ensure the user understands how to navigate their device settings, verify when the action is done, and adapt if something goes wrong."
- **→ Syrinx implication**: Voice IS inherently dual-control — the user does things off-channel ("press 1", "open your app"). The 25-point solo→interactive collapse predicts voice agents will under-perform their text scores; Syrinx should model the user as an actor with abilities/latency, not a passive transcript.

---

### 𝜏-Bench leaderboard — t-bench-leaderboard
- **Date/author**: October 13, 2025. Sierra. Leaderboard at taubench.com / tau-bench.com; code github.com/sierra-research/tau2-bench.
- **Thesis**: Model results are often published with little detail; the new leaderboard makes 𝜏-Bench evaluations transparent, interactive, community-driven, with task + trajectory visualizers so third parties can inspect *how* results were achieved.
- **Technical specifics**:
  - 𝜏-Bench (now 𝜏²-Bench) "featured in model releases from Anthropic, OpenAI, Qwen, and many others."
  - Leaderboard captures prompts, experimental setups, inference settings, compute budgets; each entry links to detailed experiment data, **complete trajectories** (full recorded agent+mock-user interactions), and a public GitHub repo.
  - **"Verified" submissions** = those including trajectories that undergo independent validation confirming reported results.
  - Community can submit own results directly.
  - **Task visualizer** (view of each benchmark domain) + **trajectory visualizer** (step through recorded agent↔mock-user interactions) → inspect reasoning/decision patterns, compare strategies across models, identify where behaviors diverge/break down.
- **Verbatim quotes**:
  - "while high-level metrics are useful, they're more valuable when third parties can inspect how the results were achieved."
  - "𝜏-Bench evolves from a static benchmark into a living framework — one that measures performance while helping the community understand why agents succeed or fail."
- **→ Syrinx implication**: Trajectory-level transparency + a "verified" badge is a strong trust play; if Syrinx publishes voice benchmarks, shipping full audio/transcript trajectories (not just a number) would differentiate and build credibility.

---

### 𝜏³-Bench: Advancing agent benchmarking to knowledge and voice — bench-advancing-agent-benchmarking-to-knowledge-and-voice
- **Date/author**: March 18, 2026. Sierra. Papers: 𝜏-Knowledge arXiv 2603.04370; 𝜏-Voice arXiv 2603.13686.
- **Thesis**: 𝜏³-Bench expands evaluation to two new frontiers — **knowledge retrieval** (𝜏-Knowledge) and **live voice** (𝜏-Voice) — plus community fixes to existing domains; both target the real-world conditions where agents are most likely to break.
- **Technical specifics**:
  - **𝜏-Knowledge / 𝜏-Banking**: fintech customer-support domain, realistic KB of **698 documents across 21 product categories (~195K tokens)**. Tasks require searching the corpus, reasoning, executing multi-step tool calls — often **identifying tools referenced only in documentation**, not explicitly listed. Supports keyword search, embedding retrieval, long-context (KB dumped into model), and **terminal-style direct file exploration**. Success = correct updates to simulated backend DB.
    - Result: best frontier model **GPT-5.2 (high reasoning) ≈ 25% of tasks**; even when handed the exact needed documents, performance rises only to **~40%** → bottleneck is *understanding + correct execution*, not just retrieval.
    - Tradeoff: freeform/terminal access > traditional semantic search on accuracy, but structured retrieval responds faster. Some models reach similar accuracy but take **9× longer**; others lower-accuracy but more consistent across trials.
  - **𝜏-Voice**: extends 𝜏-Bench to live, **full-duplex** voice with complex turn-taking. Simulates user with an accent, noisy coffee shop, spotty connection, compressed phone line. Configurable user parameters: how patient / how interruptive / how silence-averse.
    - **Providers benchmarked**: OpenAI Realtime, Google Gemini Live, xAI Grok Voice.
    - **Headline numbers**: ideal conditions (no interruptions/audio effects) best voice ≈ **54%** vs non-reasoning text **31–51%** ("clean voice"); with realistic audio + turn-taking, voice ≈ **26–38%** ("realistic voice") vs ~54%; **text agents WITH reasoning ≈ 85%**.
    - Failure patterns consistent across providers: **authentication is the bottleneck** (mishears a name/email → everything downstream fails); agents lose track of multi-step requests; never recover from repeated failures.
  - **Core-domain strengthening**: incorporated community fixes to airline/retail/telecom; external audits cited — **𝜏²-Bench Verified effort from Amazon** (github.com/amazon-agi/tau2-bench-verified) and PRs from Anthropic — resolving incorrect expected actions, ambiguities, tightening criteria.
- **Verbatim quotes**:
  - "Real conversation is full-duplex — both sides speaking and listening at once — and it's messy."
  - "under ideal conditions ... the best voice agents get close to non-reasoning text models (~54% vs 31–51% clean voice), but once you introduce realistic audio and turn-taking the gap widens substantially (~54% vs 26–38% realistic voice). Text agents with reasoning reach ~85%."
  - "authentication is the bottleneck — once the agent mishears a name or email, everything downstream fails."
  - "We're releasing 𝜏-Voice not just as a benchmark, but as a platform for evaluating voice agents — because the gap between lab conditions and real calls is where the hardest problems live."
- **→ Syrinx implication**: This is the single most load-bearing post for Syrinx. The ~85% (text+reasoning) → ~26-38% (realistic voice) cliff quantifies the exact gap Syrinx exists to close. Auth/spelling-over-audio is the #1 named failure → Syrinx should harden confirmation-code/name/email capture with verification loops, and treat reasoning-while-conversing (not just thinking longer) as the core hard problem.

---

### 𝜏-knowledge: benchmarking agents on realistic knowledge — tau-knowledge
- **Date/author**: First released early March 2026; this report ~May 13, 2026 (per modifiedTime). Sierra. Paper arXiv 2603.04370; leaderboard taubench.com (benchmark=text).
- **Thesis**: Existing benchmarks test finding info OR taking action, rarely both; 𝜏-knowledge evaluates agents searching a realistic, messy KB, reasoning over findings, and executing multi-step tool calls during a live conversation.
- **Technical specifics**:
  - **𝜏-Banking KB**: 698 documents, 21 product categories, ~195K tokens. Covers personal/business checking, tiered savings, rewards credit cards, BNPL, etc. Documents include customer-facing specs (APY, fees, cashback) AND internal agent protocols (dispute procedures, card-replacement workflows, retention offers, identity verification). Fictional bank "Rho-Bank."
  - **Task complexity**: each task needs info from an **average of 18.6 documents** and **average 9.5 tool calls**, some up to **33**. Tools often discovered/unlocked from within docs (e.g. `unlock_discoverable_agent_tool` → `call_discoverable_agent_tool` with `order_replacement_credit_card_7291`; internal tools like `get_closure_reason_history_8293`, `log_credit_card_closure_reason_4521`, `close_bank_account_7392`).
  - **Anatomy task example**: dispute + credit-limit-increase, where Credit Limit Increase Policy rejects requests if pending disputes exist → **order matters**. Named failure modes: (1) "miss critical policy dependency" (files dispute first → credit increase auto-denied); (2) "over-trust user claims" (user falsely says "my dispute was approved" → weak agents apply credit without verifying DB).
  - **Launch frontier (early March 2026)**: best model **GPT-5.2 high reasoning = 25.5% Pass^1, 9.3% Pass^4**; with relevant docs handed directly, ceiling ~40% Pass^1. (Contrast: frontier models routinely >80% Pass^1 on airline/retail/telecom.)
  - **Standardized retrieval setting**: each model given **BM25 + dense embeddings + a freeform shell**, picks its own strategy. **11 frontier model variants** evaluated at max reasoning effort. User simulator = GPT-5.2 low reasoning.
  - **Leaderboard (𝜏-Banking Pass^1)**: #1 OpenAI GPT-5.5 (Apr 22 2026) **37.4%**; #2 GPT-5.4 (Mar 5) 30.7%; #3 Anthropic Claude Opus 4.7 (Apr 16) 25.3%; #4 GPT-5.2 (Dec 11 2025) 24.7%; #5 Claude Opus 4.6 (Feb 5) 24.5%; #6 Google Gemini 3.1 Pro Preview (Feb 19) 22.5%; #7 Claude Opus 4.5 (Nov 24 2025) 21.4%; #8 xAI Grok 4.2 (Mar 10) 17.6%.
  - GPT-5.5 (xhigh reasoning) leads at **37.4% Pass^1** (+11.9 pts vs launch best); Pass^4 doubled 9.3%→20.6%. Leader still fails ~60% of tasks; ~63 pts of Pass^1 headroom remain.
  - **What separates strong agents** (from thousands of trajectories): (1) **retrieval is ongoing, not one-shot** — strong agents re-search on mid-task pivots ("actually this is a medical emergency"); (2) **search smarter not harder** — GPT-5.5 issues fewer queries than GPT-5.2 (**19.4 → 9.1 searches/task**) yet +12 pts Pass^1, via surgical queries vs spray-and-pray; (3) **calibrated restraint** — strong agents stop after the expected action set; weak ones add unrequested "helpful" extras (e.g. filing a fraud dispute alongside a card replacement). Opus 4.7 better calibrated than 4.6.
- **Verbatim quotes**:
  - "Each task requires information from an average of 18.6 documents and an average of 9.5 tool calls, with some requiring up to 33."
  - "the best frontier model — GPT-5.2 with high reasoning — passed just 25.5% of tasks on the first try (Pass^1), and only 9.3% reliably (Pass^4)."
  - "Within the GPT family, 5.5 issues fewer search queries than 5.2 (19.4 → 9.1 searches per task) while Pass^1 climbed 12 percentage points. The improvement isn't volume — it's targeting."
  - "Strong models treat retrieval as ongoing, not a one-time step."
- **→ Syrinx implication**: Retrieval is a live conversational behavior, not a preprocessing step — Syrinx's voice loop should re-query mid-call on context pivots. "Search smarter not harder" (fewer, surgical queries) directly serves the latency budget; verifying user claims against DB before acting is a concrete guardrail to bake in.

---

### μ-Bench: an open multilingual transcription benchmark — mu-bench-an-open-multilingual-transcription-benchmark
- **Date/author**: April 20, 2026. Authors named: Katie Echavia, Venu Satuluri, Ola Zytek, Victor Barres, Mindy Long, Nishita Jain, Nittai Malchin, Lydia Zarcone, Kelly Cooke. Paper research.sierra.ai/mubench; HF dataset sierra-research/mu-bench; code github.com/sierra-research/mu-bench.
- **Thesis**: Most public ASR benchmarks are English / clean read speech in quiet studios; μ-Bench measures transcription providers on real phone audio across multiple languages, with metrics that distinguish meaning-changing errors from surface ones.
- **Technical specifics**:
  - Sierra supports voice across **70+ languages** using a **constellation of ASR models** (no single provider best across all). Internally benchmarks **79 locale variants across 42 languages and 13+ providers**.
  - **Open-sourced subset (μ-Bench)**: **5 locales, 5 providers, 4,270 human-annotated utterances from 250 real phone conversations recorded at 8 kHz mono.**
  - **Languages**: English, Spanish, Turkish, Vietnamese, Mandarin.
  - **Providers evaluated**: Deepgram Nova-3, Google Chirp-3, Microsoft Azure Speech, ElevenLabs Scribe v2, OpenAI GPT-4o Mini Transcribe.
  - **New metric: Utterance Error Rate (UER)** — isolates meaning-changing errors from surface-level ones (a dropped "uh" vs a misheard phone-number digit count the same under WER but differ in UER). Two providers can share WER but differ sharply in UER.
  - **Findings**: Google Chirp-3 leads on accuracy but among the slowest; Deepgram Nova-3 **~8× faster on p50 latency** but trails on multilingual accuracy. **Mandarin accuracy can be 5× worse than English**; Vietnamese varies wildly across providers.
  - Full writeup covers dataset construction, why traditional normalization breaks for Chinese homophones, UER scoring internals, statistical significance testing across all provider pairs, multi-provider ASR deployment lessons. Open leaderboard, accepts submissions.
- **Verbatim quotes**:
  - "Word Error Rate alone is misleading. Not all transcription errors are equal — a dropped 'uh' and a misheard phone number digit count the same under WER. We introduce a new metric, Utterance Error Rate (UER), that isolates meaning-changing errors from surface-level ones."
  - "Google Chirp-3 leads on accuracy but is among the slowest. Deepgram Nova-3 is nearly 8× faster on p50 latency but trails on multilingual accuracy. The right choice depends on the deployment."
  - "Mandarin transcription accuracy can be 5x worse than English."
- **→ Syrinx implication**: Direct prior art for Syrinx's multi-provider ASR routing. UER (not WER) is the metric that predicts voice-agent task failure — adopt it. The accuracy-vs-latency provider tradeoff (Chirp-3 vs Nova-3 8×) validates Syrinx's per-language provider-routing thesis and the ~800ms-1000ms latency budget.

---

### Simulations: the secret behind every great agent — simulations-the-secret-behind-every-great-agent
- **Date/author**: August 19, 2025. Sierra.
- **Thesis**: Because agents produce different outputs from the same input, traditional pass/fail testing breaks; Sierra's Agent OS auto-generates simulated conversations (agent + mock user + LLM judge) to verify agents *before* launch and prevent regressions on every change.
- **Technical specifics**:
  - **Anatomy = agent, user, judge.** Configurable "users": different languages, tech comfort, tones (buying shoes, exchange without receipt, mortgage application, troubleshooting, French late-night, cancel subscription). Configure starting context (logged in? email available?) to mirror real environment.
  - **Variety stress example**: identity verification by email — user might spell letter by letter, say as one word, or any combination; agent confirmation also varies.
  - **Judge**: an independent agent grades output — did the agent let the user achieve their goal, follow the SOP, stay within brand guidelines, produce accurate/helpful/comprehensible responses.
  - **Auto-generation**: when an agent is created, test cases auto-generated from: SOPs, knowledge bases, historical coaching transcripts, conversation flows. Tests persist and re-run on every update.
  - **Distribution**: for CX teams, sims live alongside Journeys in Agent Studio; agents should pass before any Journey change publishes. For developers, plug into CI/CD via GitHub Actions or CLI; **gate releases on specific simulations like unit tests**.
  - **Scale numbers**: Sierra customers running **over 35,000 tests/day (and growing)**; achieving **resolution rates up to 90%** and **CSAT exceeding 4.5/5.0**.
- **Verbatim quotes**:
  - "Agents don't follow scripts. Your tests can't either."
  - "with AI the same inputs will produce different outputs ... So the key question is not whether an agent did what it was told but whether it enables customers to accomplish their goals."
  - "Sierra's customers are running over 35,000 tests (and growing) each day, enabling them to regularly achieve resolution rates of up to 90% and CSAT exceeding 4.5/5.0."
- **→ Syrinx implication**: Simulations are productized 𝜏-bench — Syrinx needs an equivalent: auto-generated, persistent, CI-gateable voice sims (agent+user+judge) seeded from a customer's own SOPs/KB. The spelling-variation example maps exactly to the voice auth bottleneck from 𝜏-Voice.

---

### Golden articles: Evaluating and improving search — evaluating-and-improving-search
- **Date/author**: April 14, 2026. Sierra. (Companion to the Linnaeus/Darwin post.)
- **Thesis**: Search quality can't be measured against static test data because KBs/policies/issues change; Sierra builds daily "golden datasets" from real production conversations and feeds the signals into a continuous improvement loop, with "good search" defined in terms of resolution.
- **Technical specifics**:
  - For each org, **sample thousands of anonymized examples from the previous day's conversations** at the points where an agent searched its KB.
  - **Golden-dataset pipeline**: an automated pipeline determines which articles would have best resolved the issue at that conversation point; a **multi-stage pipeline of frontier LLMs** filters and ranks to identify the ideal set (includes both direct-answer articles AND essential background/supporting info).
  - Compare golden articles vs what the agent actually retrieved → **daily retrieval metrics per customer**: **recall** (found everything needed?), **precision** (avoided noise?), **nDCG** (normalized discounted cumulative gain — correct importance ordering?). Sample shown: Recall 67%, Precision 50%, nDCG 74%.
  - **Improvement loop**: inspect failed conversations → spot patterns (reorganized KB, coverage gaps) → fix via model / search settings / KB reorganization. Case study: one company's content from different brands wasn't separated → system pulled irrelevant articles → after separating brands, accuracy improved immediately.
  - After releasing retrieval+reranking models, **recall improved day by day**, correlating with **resolution-rate improvements of up to 16 percentage points**.
  - **Resolution rate** defined: % of conversations fully handled by the agent without handover to a human associate.
- **Verbatim quotes**:
  - "You can't measure search quality against static test data because knowledge bases change, new policies get introduced, and customer issues evolve."
  - "Better retrieval doesn't just return better articles — it determines whether a conversation is successfully resolved."
  - "Those gains also correlated with resolution-rate improvements of up to 16 percentage points."
- **→ Syrinx implication**: Eval data should be regenerated daily from live traffic, not frozen. The "golden article" methodology (frontier-LLM pipeline labels the ideal retrieval set per real conversation) is directly portable to building Syrinx voice/RAG evals tied to resolution rather than relevance.

---

### Meet Linnaeus and Darwin: Search models that drive higher resolution rates — meet-linnaeus-and-darwin-the-sierra-search-team
- **Date/author**: April 3, 2026. Sierra.
- **Thesis**: General-purpose search optimizes accuracy/relevance for a single response; Sierra rebuilt search around the *goal behind the question* using two purpose-built models — **Linnaeus** (retrieval) and **Darwin** (reranking) — to assemble everything an agent needs to fully resolve an issue.
- **Technical specifics**:
  - **Scale**: agents on Sierra perform **over two million searches a day** / "hundreds of millions a year" across knowledge bases.
  - **Four eval dimensions**: Speed (**P90 latency reduced >75%**), Cost (search costs **down >75%**), Quality (**recall@30 brought up to ~95%**), Outcomes (**up to 16 pp resolution-rate gains**).
  - **Linnaeus (retrieval)**: transcript-aware — operates directly on **full conversations** when appropriate, preserving nuance (contact lenses vs other prescriptions) and **removing the separate query-generation step** (which adds latency and compresses context). Off-the-shelf embedding models are optimized for short queries, not multi-turn conversations; Linnaeus is purpose-built for conversational transcripts, evaluated against tens of thousands of real conversations. Retrieves the *set* needed to move forward (policies, edge cases, next steps). **recall@5 up 20%, recall@30 at ~95%, latency reduced up to ~800ms per search.**
  - **Darwin (reranking)**: customer-experience-aware — frontier LLMs rerank well but are too slow/expensive at scale; small models miss reasoning-dependent context. Darwin identifies both directly AND indirectly relevant info (e.g. surfacing profile settings when a customer asks about changing their name), delivering precision + efficiency, reducing cost/latency.
  - **Pipeline**: (optional) generate query → **Linnaeus retrieve** → **Darwin rerank** → response. Worked example labels: "Core answer," "Additional information," "Resolution blocker" (name-mismatch/ID verification at pickup), "Generic," "Off-target."
  - Redefines **relevance grounded in resolution**: return info enabling policy-compliant decisions, anticipate downstream steps, avoid resolution dead-ends, provide context for escalation.
- **Verbatim quotes**:
  - "Most knowledge base search is built to answer the immediate question. But great customer experiences address the goal behind it."
  - "Linnaeus operates directly on full conversations when appropriate. This preserves nuance ... and removes the need for a separate query generation step."
  - "This shift improves recall (recall@5 up 20%, recall@30 at ~95%) while reducing latency by up to ~800ms per search."
  - "Retrieval casts a wide net. Darwin selects what will actually help resolve the issue."
- **→ Syrinx implication**: Transcript-aware retrieval (skip query-generation, embed the conversation directly) is a concrete latency win (~800ms) Syrinx could replicate in its voice loop. The retrieval/rerank split (fast wide net + CX-aware reranker) and "relevance = resolution" framing are a model architecture worth mirroring for Syrinx's RAG layer.

---

### Expert Answers: Turn everyday support conversations into compounding knowledge — expert-answers
- **Date/author**: January 22, 2026. Sierra. (Part of Insights 2.0.)
- **Thesis**: Company answers are scattered across help centers, transcripts, chat logs, and reps' heads, and resolve one issue then disappear; Expert Answers automatically turns human-handled resolutions into grounded, reviewable knowledge articles that feed back into the AI agent.
- **Technical specifics**:
  - **5-step loop: Gap → Resolve → Draft → Approve → Reuse.** Identifies where the agent needed human help; learns from patterns across how similar issues were resolved; generates a **draft knowledge article** care teams review (instead of writing from scratch); each draft approved before publication; agent then handles those questions more accurately/consistently.
  - Works with **Live Assist** to share knowledge across the whole support team ("every care representative to perform at the level of the best").
  - Integrates with **Knowledge Performance** (article-reference analytics).
  - **Case studies (no model numbers, business outcomes only)**: premium retailer with peak holiday season — an auto-drafted article quickly became a **top-five most-referenced source**. Digital health company — published Expert Answers articles from real care-team conversations, tested on a traffic subset, **resolution rates increased 4%** with no extra care-team work, prompting full rollout. Large retailer used it to keep its customer-facing help center current.
- **Verbatim quotes**:
  - "The issue gets resolved but the agent learns nothing — unless someone manually writes a new help center article. Expert Answers automatically closes that loop."
  - "every resolved edge case strengthens the agent for the future."
  - "Resolution rates increased 4% with no additional work from the care team, prompting a full rollout."
- **→ Syrinx implication**: The human-escalation → auto-drafted-article → agent-reuse loop is how Sierra compounds its knowledge moat over time. For Syrinx, the analog is mining escalated/failed *voice* calls into new KB/playbook entries — closing the loop is a defensibility play, not just a feature.

---

## Cross-cutting synthesis for Syrinx

- **The Tau universe is a deliberate moat**: a single stateful-DB-diff evaluation methodology (no LLM judge) extended across modalities — text (𝜏-bench), collaboration (𝜏²), knowledge retrieval (𝜏-Knowledge/Banking), voice (𝜏-Voice), transcription (μ-Bench). Each release reuses the same core (simulated user + tools + policies + objective state check) and adds one axis of real-world messiness.
- **Reliability metric lineage**: pass^1 → **pass^k** (same task, k trials) is now industry standard (Anthropic model cards). Knowledge work reports Pass^1 + Pass^4.
- **The voice gap is quantified and central**: text+reasoning ~85% vs realistic voice ~26-38% on the same tasks. Auth/spelling-over-noisy-audio is the named #1 failure. This is the gap Syrinx targets.
- **Search = in-house models (Linnaeus retrieval, Darwin rerank), relevance redefined as resolution**, evaluated daily against golden datasets built by frontier-LLM pipelines from real traffic, closed-loop with Expert Answers. Concrete wins: recall@30 ~95%, P90 latency −75%, cost −75%, +up to 16pp resolution, ~800ms/search latency cut.
- **Simulations are productized benchmarks**: 35,000+ tests/day, CI-gateable, auto-seeded from customer SOPs/KB — the deployable counterpart to 𝜏-bench.
