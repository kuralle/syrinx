---
id: REL-06
title: Graceful degradation per layer — never fail silently
domain: REL
tags: [degradation, fallback, resilience, escalation, confidence, canned-audio]
sources: [deepgram-ebook, vapi-pipeline-2]
code_refs: [pipecat/src/pipecat/services/ai_service.py:1, agents/livekit-agents/livekit/agents/tts/fallback_adapter.py:46]
---

**Claim (one line):** Each speech-path layer has a distinct graceful-degradation move, and the cardinal rule across all of them is the same: voice agents must never fail *silently*.

**Detail.** Deepgram's "Resilience and Graceful Degradation" prescribes a per-layer recovery (ebook line 902-916): **reasoning/retrieval fails** ⇒ acknowledge verbally and recover or escalate to a human; **synthesis (TTS) fails** ⇒ use a fallback voice or *canned audio* response; **transcription confidence drops** ⇒ prompt for clarification rather than proceeding on uncertain input; **automated recovery exhausted** ⇒ escalate to a human operator rather than trapping the user in a dead end. The unifying invariant (ebook 904-905, 770): *"Voice agents should never fail silently"* / "callers never experience unexplained silence." Mechanisms: Vapi's confidence-based filtering discards very-low-confidence transcripts and only lets higher-confidence ones interrupt (vapi-pipeline-2 §3) — the "drop confidence ⇒ reprompt" lever. TTS-fail-to-fallback-voice is the [[REL-08-fallback-adapter-availability]] FallbackAdapter (`tts/fallback_adapter.py:46`). Pipecat encodes the "don't crash, let the app degrade" stance in its error contract: services `push_error(..., fatal=False)` by default so application code can catch and switch service rather than tearing down the pipeline (per AGENTS.md error-handling rule; `ai_service.py`).

**Prior-art divergence.** Deepgram = the canonical *taxonomy* (which layer degrades how). Vapi operationalizes the STT-confidence branch (filter + interrupt-gating). LiveKit operationalizes the TTS/STT branch as automatic provider failover. The "escalate to human" branch is an orchestration-layer concern, above the speech engine. Pipecat's `fatal=False` default is the enabling primitive: non-fatal errors keep the pipeline alive so degradation logic can run.

**Implication for Syrinx.** Build a degradation table by layer: STT low-confidence ⇒ reprompt; TTS fail ⇒ fallback voice / canned clip; reasoning fail ⇒ verbal ack + escalate. Make provider errors non-fatal so the orchestrator can choose the degraded path. The one hard rule: emit *something* — silence is the worst failure.

Links: [[REL-08-fallback-adapter-availability]] [[REL-10-failure-mode-catalog]] [[STT-02-partial-final-lifecycle]] [[REL-04-state-restoration-injected]]
