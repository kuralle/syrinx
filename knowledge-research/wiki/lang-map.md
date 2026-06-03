# LANG — Multilingual & Localization (Map of Content)

## Core problem
As voice agents expand globally, language support shifts from a feature add-on to a *system-level concern* affecting every layer — STT model selection, LLM response language, TTS voice and prosody, orchestration routing, and UX norms. The core challenge is preserving **conversational continuity and persona consistency** while the system adapts to the user's language in real time, without disruptive session resets. Language detection must be a probabilistic signal that *informs* the pipeline, not a hard gate that forks it — and when the user code-switches, the TTS voice must follow without dropping context.

## Narrative
Start with the architectural choice: **unified multilingual streams** powered by a single model that handles multiple languages dynamically [[LANG-01-unified-multilingual-streams]], vs language-specialized streams that optimize accuracy for one language at the cost of continuity. Unified streams enable natural code-switching and avoid disruptive reconfiguration — Deepgram strongly recommends continuity-first for real-time agents unless regulatory or cost constraints dictate otherwise.

When the user does switch languages, the TTS voice must follow **dynamically, without resetting context** [[LANG-02-dynamic-voice-switching]]. This requires hot-swapping the TTS voice/language within an active streaming session — a capability no OSS clone currently implements natively, making it a Syrinx design challenge. The TTS voice mapping must be pre-selected from the same provider family for tonal consistency.

The signal driving these switches is **language detection as a probabilistic signal** [[LANG-03-language-detection-probabilistic]] — it emerges early from the STT stream as a `language_code` + confidence, incremental rather than decisive, and progressively informs LLM response language, TTS voice warm-up, and fallback behaviour without breaking turn-taking or interruption handling.

The UX payoff is **persona consistency across languages** [[LANG-04-persona-consistency]]: the agent must feel like the same character in every language. Inconsistent tone, pacing, or expressiveness breaks trust faster than minor recognition errors. Persona is maintained through voice-pair pre-selection, consistent pacing/turn-taking SLAs per language, and localization (not translation) of prompts and acknowledgments.

## Canonical implementations
- **Deepgram Nova-3 Multilingual** (source only): real-time multilingual transcription across languages in one session, with `detect_language=true` parameter — described in ebook ~796–868, demonstrated in Language Coach reference pattern (~1429–1455).
- **Rapida (voice-ai):** `transformer/deepgram/deepgram.go:92-117` branches on keyword-vs-keyterm model params; `stt_callback.go:52-143` handles `is_final` emits language-agnostically. No explicit language-routing layer.
- **Other clones:** Pipecat, LiveKit Python/JS, and Cloudflare leave language selection entirely to the STT provider's initialization parameters — no mid-session language detection, routing, or TTS switching is exposed in pipeline code.

## Open questions / gaps
- **Dynamic TTS switching mid-stream is unimplemented in all clones.** All initialize TTS with a fixed voice/language at session start. Hot-swapping requires either a new streaming socket (with audio gap) or TTS provider support for in-session voice changes — unverified which providers support this.
- **Language-detection confidence propagation:** Deepgram's `detect_language` emits a `language_code` but no clone surfaces it as a pipeline frame. Syrinx must add a language-metadata frame to the frame taxonomy.
- **Tonal voice-matching across languages** is a manual curation task — no automated tooling or provider API exists for cross-language voice similarity search.
- **Localization is a process, not a feature.** Prompts, error messages, and knowledge grounding must be authored per-language, not translated — this is a content-engineering discipline, not a code one.

Neighbors: [[wiki/stt-map]] [[wiki/tts-map]] [[wiki/turn-map]]
