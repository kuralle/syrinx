---
id: ARCH-11
title: Guardrails-before-TTS — the irreversibility constraint in the voice pipeline
domain: ARCH
tags: [guardrails, safety, moderation, tts, irreversibility, architecture, pipeline-ordering]
sources: [together-talk, deepgram-ebook]
code_refs: [deepgram-ebook L1238-1244]
---

**Claim (one line):** Spoken output is irreversible — unlike text chat where a guardrail can block a response before it's displayed, TTS audio leaves the speaker immediately — so the architectural rule is mandatory: all safety/moderation/content checks MUST execute between LLM output and TTS input, not after, and no OSS voice-engine clone enforces this today.

**Detail.** Together AI's rule: "guardrails after LLM generation, before TTS — because 'you can't take back spoken words' → must catch violations before TTS is invoked" (together-talk). This is a different ordering constraint than text-based agents, where guardrails can execute after the full response is formed and block delivery. With TTS, the first audio chunk may be streaming out before the full response text is even generated — a guardrail that checks the complete text can only run before TTS starts. There are two architectural positions for the guardrail:

1. **Pre-TTS text check** (Together's recommendation): intercept the full or sentence-level LLM output text, run content moderation before handing to TTS. Blocking here means the agent either skips the turn (silence) or substitutes a canned refusal response. Cost: adds inference latency to the TTS critical path ([[LAT-13-guardrail-classifier-latency]]).

2. **Streaming word-level check**: run a faster classifier on each sentence/chunk before synthesis. Lower latency but may miss violations that span sentence boundaries.

**Clone audit.** A systematic grep for `guardrail`, `moderation`, `safety`, `content_check`, `before_tts`, `can_reply`, `toxicity` across LiveKit Python (`voice/agent_activity.py`, `voice/agent_session.py`, `voice/agent.py`) and Pipecat (`processors/`) returned **zero** results in the voice-pipeline hot path. LiveKit's `evals/judge.py` has an evaluation-time safety judge, but it is not an in-pipeline guardrail. Pipecat's pipeline has no safety processor between LLM output and TTS input. This means: **no open-source voice-engine clone implements a pre-TTS guardrail gate today.** The architecture is correct — the LLM→TTS edge is where content moderation must live — but the code doesn't exist yet.

Deepgram's Common Failure Modes appendix (Chapter 9) does not list "agent speaks harmful content" as a failure mode; that appendix is about latency, audio quality, and context management. (Note: this is a gap only in the failure-mode appendix — the same ebook devotes Chapter 5, "Content Safety and Guardrails," to harmful-content moderation, so safety is not a scope gap in this source.)

**Prior-art divergence.** The *requirement* is well-articulated in prior art — Together and Deepgram independently specify a pre-synthesis guardrail with the identical irreversibility rationale. Deepgram's Chapter 5 "Output Filtering: Controlling What Is Spoken" states the final safeguard "verifies model output before it is converted to speech ... only validated text should ever reach the synthesis stage," running each response through a post-generation filter to "suppress or rewrite the response before synthesis" (deepgram-ebook L1238-1244). What is missing is not the articulation but the *implementation*: no OSS voice-engine clone ships this gate (see Clone audit above), so building it remains a design task, not a clone-reference task.

**Implication for Syrinx.** Insert a mandatory guardrail processor between LLM output and TTS input in the frame pipeline. It must: (a) operate on sentence-level text chunks (matching [[TTS-03-sentence-aggregation]] granularity), (b) block/replace violating text before any audio is synthesized, (c) log violations for [[OBS-10-synthetic-real-user-monitoring]], and (d) have its own latency budget so it doesn't blow the turn timeline. This is Syrinx-differentiating — no clone has it.

Links: [[LAT-13-guardrail-classifier-latency]] [[TTS-03-sentence-aggregation]] [[TTS-08-interruptible-tts]] [[OBS-10-synthetic-real-user-monitoring]] [[ARCH-10-voice-engine-orchestration-boundary]]
