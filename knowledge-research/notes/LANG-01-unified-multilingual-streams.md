---
id: LANG-01
title: Unified multilingual streams — single model for dynamic multi-language conversation
domain: LANG
tags: [multilingual, unified-stream, language-switching, code-switching, deepgram, nova-3]
sources: [deepgram-ebook]
code_refs: [voice-ai/api/assistant-api/internal/transformer/deepgram/deepgram.go:92]
---

**Claim (one line):** A unified multilingual stream uses a single STT model (e.g., Nova-3 Multilingual) that recognizes and responds in any language dynamically within one session, preserving conversational continuity and natural code-switching without disruptive reconfiguration.

**Detail.** Deepgram defines two multilingual strategies (deepgram-ebook ~808–818): (1) **unified multilingual conversational streams** — powered by a multilingual model that understands and generates replies in many languages in the same session, and (2) **language-specialized streams** — where the system converges on a dominant language and optimizes for it over time. Unified streams "prioritize continuity. They avoid disruptive mid-conversation transitions, simplify orchestration, and handle moderate code-switching naturally" (ebook ~822–825). A concrete example: "a customer support bot that responds in Spanish, then seamlessly switches to French if the user changes languages mid-conversation" (ebook ~816). The Rapida Go codebase reflects this in its Deepgram transformer: `deepgram.go:109-114` branches on `opts.Model` (nova-2 → `Keywords`, nova-3 → `Keyterm`) from one `listen.keyword` input key (read at `deepgram.go:92`), and the STT callback (`stt_callback.go:52-143`) handles `is_final` emits independent of language — the stream is language-agnostic.

Deepgram's Language Coach reference pattern (ebook ~1429–1455) demonstrates the approach: Nova-3 Multilingual for real-time transcription across languages within one continuous session, enabling natural code-switching without session reinitialization. Because multilingual STT, dynamic TTS switching, and LLM prompt-language routing all happen within the same event-driven session, the user experiences seamless adaptation rather than reconfiguration.

**Prior-art divergence.** Deepgram explicitly advises: "In practice, real-time voice agents benefit most from minimizing disruption. Continuity usually matters more than marginal accuracy gains unless regulatory, domain-specific, or cost considerations dictate otherwise" (ebook ~824–827). This is a design philosophy, not universally adopted — some systems (language-specialized) let users pre-select a language and optimize a dedicated model for it. Neither Pipecat, LiveKit, nor Rapida expose a language-routing layer in their pipeline code — they leave language selection to the STT provider's configuration parameters.

**Implication for Syrinx.** Default to a unified multilingual STT model (e.g., Deepgram Nova-3 Multilingual or equivalent). Never hard-fork a session on language change. Route the language signal to the LLM (for response language) and TTS (for voice selection) as a probabilistic hint, not a state-resetting gate.

Links: [[LANG-02-dynamic-voice-switching]] [[LANG-03-language-detection-probabilistic]] [[LANG-04-persona-consistency]] [[STT-01-streaming-vs-batch]]
