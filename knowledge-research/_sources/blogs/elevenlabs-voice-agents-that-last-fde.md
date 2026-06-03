# Building voice agents that last: lessons from forward-deployed engineering (ElevenLabs)
Source: https://elevenlabs.io/blog/building-voice-agents-that-last-some-lessons-learned-from-forward-deployed-engineering
Captured: 2026-06-03

Deflection ≠ resolution. Revolut deployment (70M customers): **8x reduction in time-to-resolution, 99.7% call success rate**.

## Shipping agents vs shipping software
Two components: (1) **traditional software** and (2) **core orchestrator**.

> IMAGE (image1.webp): deployment channels — telephony, contact-center platforms, digital surfaces, messaging apps, SDK/API integrations.
> IMAGE (image4.webp): observability/governance — evaluations, testing, simulations, compliance, PII redaction, continuous improvement.
> **IMAGE (image2.webp) — KEY ARCHITECTURE DIAGRAM:** "How the **Voice Engine** handles audio orchestration (**speech-to-text, turn taking, interruption detection**) and passes **transcripts** to the **Agent Orchestration** layer, where an LLM reasons over a system prompt, knowledge base, and RAG to drive workflows and routing." → This is the clean split: **Voice Engine (speech in/out) → transcript → Agent Orchestration**. Our project = the Voice Engine half.

**Traditional software components** (versioning, A/B testing, telephony, first-message config): little/no drift after deployment, highly predictable. Latency improvements follow well-understood patterns — **caching, connection pooling, infrastructure scaling, protocol optimization** = reliable levers with deterministic outcomes.

**Core Orchestrator components**: harder to predict, dictate runtime performance (answer quality + perceived latency). Operate over natural language and audio → unbounded input space; small changes in phrasing/context/background noise/user behavior produce meaningfully different outputs. Conventional testing insufficient. **Latency here is less deterministic** — driven by model inference times, **injection of auditory artifacts**, tool-call chains, generative variability. Requires evaluation frameworks, production monitoring, continuous iteration on real conversation data.

## Release cycle
### Selecting path-finders
Pick use cases by: measurable business value; clear scope/purpose to users; codifiable good/bad interaction criteria; tradeoff between performance and control (too locked down = "glorified IVR"; too fast = support burden).

### Grounding the build (TDD)
> IMAGE (image3.webp): agent dev lifecycle — scoping → continuous cycle of (define tests → build → deploy); pre-production AND production failures loop back to expand the test suite.

Two foundational artifacts: **Success Evaluation Criteria** + **Agent Tests**. Then system prompt. Configure core components: **LLM, TTS model, voice**. **LLM selection = latency-vs-performance trade-off** (speed-optimized models sacrifice reasoning). **TTS choice depends on use case** — expressive delivery vs low latency vs multilingual. Voice = brand decision, can happen in parallel.

### Toward production readiness
Tight loop: add tests, identify failures, update prompt/config, rerun. Most failures = prompt failures, not model failures. Recurring failure patterns: prompt ambiguity, tool misuse, escalation drift. Simulation testing catches full-conversation failures (context drift, compounding errors) that turn-level tests miss.

### Feedback loops / when to stop
Conversation Analysis pinpoints the exact failure moment. Validate changes (branched/versioned rollouts to a small % before full rollout). What goes wrong: skipping branched rollouts (lose observability); over-indexing on recent failures (reactive prompt changes cause regressions); evaluation drift (bar erodes informally). Scaling = confidence decision not time-based. Batches <100 calls/branch = too much variance. Best deployments: task completion >80%, escalation <20%; stability across weeks matters more than any single number.
