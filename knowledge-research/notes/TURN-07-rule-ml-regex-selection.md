---
id: TURN-07
title: Endpointing method selection — rule-based / ML / external / regex / LLM-gated
domain: TURN
tags: [endpointing, selector, rule-based, regex, strategies]
sources: [vapi-pipeline-2, diagrams]
code_refs: [pipecat/src/pipecat/turns/user_turn_strategies.py:27, pipecat/src/pipecat/turns/user_stop/speech_timeout_user_turn_stop_strategy.py:48, pipecat/src/pipecat/turns/user_stop/llm_turn_completion_user_turn_stop_strategy.py:18]
---

**Claim (one line):** Endpointing is a pluggable *strategy chain*, not one algorithm: rule-based delays, ML prediction, external models, regex matching, or an LLM-completion gate — selectable and combinable.

**Detail.** Vapi lists four endpointing approaches "usable individually or combined" (`vapi-pipeline-2` Problem #4): **Rule-Based** (per-message-content delays — numbers vs punctuation vs plain statements get different timeouts), **Intelligent/ML** (context-aware predicted wait), **Custom External Models**, and **Regex Pattern Matching** (against assistant responses, user inputs, or both). A selector auto-chooses with fallbacks (`diagrams` vapi-conversational-context: `Conversation Context → Endpointing Selector → {Rule-Based, ML, Regex} → Timeout Decision`). Pipecat realizes this as composable **user-turn strategies** (`user_turn_strategies.py`): start strategies `[VADUserTurnStartStrategy, TranscriptionUserTurnStartStrategy]` and stop strategies, default `[TurnAnalyzerUserTurnStopStrategy(LocalSmartTurnAnalyzerV3)]` (`:40`, `:51`). Concrete stop strategies = the menu: `SpeechTimeoutUserTurnStopStrategy` (rule/timer-based, default `user_speech_timeout=0.6s`, `speech_timeout_user_turn_stop_strategy.py:48`), `TurnAnalyzerUserTurnStopStrategy` (ML model), `ExternalUserTurnStopStrategy` (external control), and `LLMTurnCompletionUserTurnStopStrategy` — an LLM-gated finalizer where the LLM must prefix every reply with ✓ (complete) / ○ (incomplete-short) / ◐ (incomplete-long), and only ✓ ends the turn (`llm_turn_completion_user_turn_stop_strategy.py:18-43`, `user_turn_strategies.py:104-153`).

**Prior-art divergence.** Vapi = an auto-selector that *picks* a method per context. Pipecat = an explicit *chain* the developer composes (strategies evaluated in order, `ProcessFrameResult.CONTINUE`). LiveKit collapses the menu to one ML-modulated timer [[TURN-06-livekit-eou-internals]]. Pipecat's LLM-completion gate is a fifth method neither Vapi nor LiveKit ship: it asks the *reasoning* LLM, not a dedicated turn model, whether the user is done.

**Implication for Syrinx.** Model turn detection as a strategy interface from day one. The cheap default (VAD-start + ML/timer-stop) covers most calls; regex/rule stops earn their keep on structured inputs (phone numbers, confirmations) where you *know* the expected utterance shape. The LLM-completion gate is powerful but adds an LLM round-trip to every turn boundary — reserve for high-stakes flows.

Links: [[TURN-03-semantic-vs-timeout-endpointing]] [[TURN-05-smartturn-internals]] [[TURN-06-livekit-eou-internals]] [[wiki/turn-map]]
