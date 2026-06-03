# Unpacking ElevenAgent's Orchestration Engine
Source: https://elevenlabs.io/blog/unpacking-elevenagents-orchestration-engine
Captured: 2026-06-03 (speech-in/speech-out focus)

> ElevenAgents are powered by a low-latency orchestration engine purpose-built for real-time conversations, **adding less than 100ms of overhead**. Combines ElevenLabs research with frontier LLMs (OpenAI, Google, Anthropic) + select OSS models hosted by ElevenLabs. Uses **multiple models at various stages of the answer pipeline**. The piece is about "which model sees what tokens, and when" — management of conversation history across the interaction.

## Independent agent
Minimally valuable agent = system prompt + tools + knowledge base. Favor independent agents over workflows when there is limited need to verify a strict sequence of steps, or when avoiding knowledge silos matters. Knowledge silos = certain tools/docs/history accessible to some sub-agents but not others — inherent to multi-agent workflows; tradeoff between flexibility and determinism.

Independent agents must: construct effective generation requests; retrieve+incorporate relevant docs; generate+execute tool calls; output results for eval and data collection.

### Building conversation context
A conversation = series of turns; each turn = exchange of messages. Alternating list of agent/user messages is the starting point. **During each turn the LLM receives generation requests containing alternating agent/user messages that is one message longer than the previous turn**, prefixed with a single system message (system prompt).

> IMAGE (618ry9u5gu-standalone.webp): "Every LLM request is built from the same core blocks — conversation history, knowledge base retrieval, and tools — all assembled into a single generation request at the moment the agent needs to respond."

**GOLDEN NUGGET (latency):** The orchestrator reduces *perceived* LLM latency by **predicting when a user has finished speaking. In some cases this results in multiple LLM generation requests with the same conversation context within a single turn.** (i.e. speculative generation on predicted endpoint.)

Knowledge Bases build on RAG with an optimized multi-model architecture (see their "engineering-rag" post). Enables reliable retrieval even when the most recent user input is a follow-up / acknowledgment / lacks an explicit question.

### Tools
Every enabled tool increases the serialized prompt size (name, description, parameter schema included alongside system prompt + history). More tools = more reasoning burden. Tool *description* (in Agent Builder) = what it does + what fields it returns (what the LLM uses for context). The *conditions for invoking* belong in the system prompt. Separation of concerns keeps tool defs reusable across agents.

Tool types: Webhook tools (external APIs); Client tools (dispatch requests as events through the conversation websocket); System tools (built-in, e.g. call transfers); MCP tools (connect to MCP servers).

Tool output added back to conversation so model can refer to it; can also update stored info as a **dynamic variable** (key-value pairs extracted from tool response via predefined mappings) → working memory that evolves.

**Tool execution modes (latency-relevant):**
- **Immediate Mode** — tool executes as soon as the LLM requests it. Default for fast lookups. Combined with **pre-tool speech**, agent first emits a brief acknowledgement ("Let me check that for you") returned to the user **while the tool runs in parallel, minimizing dead air**. For slower tools the platform automatically extends these filler messages to match the expected wait time.
- **Post-Tool Speech Mode** — delays execution until the agent has finished speaking. For consequential actions (transfer, end session, submit payment). User hears full context and can interrupt before action.
- **Async Mode** — runs entirely in background without pausing the conversation. Fire-and-forget (send email, trigger workflow, log data).

### Measuring performance
Data Collection (extract structured info from transcript) + Evaluation Criteria (was the call successful). Post-call webhook → finalized transcript (incl tool execution + metadata) through an LLM with all configured data-collection points + eval criteria. **The eval/extraction LLM is fixed to a low-latency model for fast processing** (flexibility planned).

Best practices — Eval criteria: one clear goal per criterion; observable/transcript-based; explicit success/failure/unknown; concise; language of rationale matches description language. Data collection: describe exactly what to extract; match expected type; use enums when set is fixed; one extraction target per item; keep descriptions short.

## Workflows
Visual interface for complex conversation flows → produces the logical object the orchestrator uses to manage subagents/tools/transfers under one independent agent identifier.

> IMAGE (d9pf2uz67d-workflow.webp): "ElevenLabs Workflows dynamically route conversations — each node gets its own focused context, tools, and goals, while conversation history flows seamlessly across every transition."

Workflows reuse independent-agent functionality: shared base system prompt, core tools, global knowledge bases always available. Sub-agents operate in a directed graph; each has a narrowly scoped objective + additional prompt/tools/knowledge for its role. Layered via prompt composition + selective context extension. **Conversation history is preserved across sub-agent transitions** but each sub-agent has a constrained view (selective KB/tool exposure = silos). **The orchestrator object is rebuilt on every transition as if it were an independent agent** → deterministic prompt state/config/capabilities.

### Workflow transitions (LLM conditions)
Transitions controlled by explicit conditions: deterministic (unconditional, dynamic-variable expression checks, tool-result conditions) or LLM-evaluated (semantic, natural-language criteria). **Important: LLM conditions are evaluated OUTSIDE the active agent's system prompt and do not influence generation — they are evaluated in parallel by the orchestrator against current conversation state.** Prevents transition logic from contaminating the agent's prompt. Safeguards monitor transitions to prevent non-productive routing cycles.

## Safety & Security
- **Guardrails:** configurable moderation/alignment evaluates user+agent messages in real time. Classified across risk categories (sexual, violence, harassment, hate, self-harm), independently configurable thresholds. Trigger → conversation immediately terminated, client notified with failure reason. **Operate outside the agent's prompt logic** — enforcement layer that can't be bypassed by model/user input.
- **Zero Retention Mode (ZRM):** all call data processed in memory only, never persisted. No transcripts/audio/analysis in dashboard. Post-call webhooks still receive outputs. Under ZRM, restricts LLMs to providers contractually prohibiting training/retention (currently Google Gemini, Anthropic Claude).

## Looking ahead
Expanding: configurable eval models, richer transition controls, deeper observability into prompt composition and token usage across stages.
