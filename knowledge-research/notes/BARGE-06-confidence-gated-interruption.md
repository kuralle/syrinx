---
id: BARGE-06
title: Only high-confidence speech may interrupt
domain: BARGE
tags: [confidence, gating, threshold, false-positive, min-duration]
sources: [vapi-pipeline-2, diagrams]
code_refs: [agents-js/agents/src/inference/interruption/defaults.ts:8, agents/livekit-agents/livekit/agents/voice/turn.py:117]
---

**Claim (one line):** Not every detected sound should stop the agent — interruption is gated by a confidence/duration/word threshold so coughs, "mm-hm" backchannels, and STT artifacts don't kill the agent's turn.

**Detail.** Vapi's partial-transcript filter has three outputs and only the top tier interrupts: "Discard (conf < X), Keep (X < conf < Y), Interrupt (conf > Y) — only high-confidence partials may barge-in on the agent" (diagrams line 21-25; vapi-pipeline-2 line 31 "only higher-confidence transcripts can interrupt the AI while it's speaking"). LiveKit gates on *duration and word count*: `_INTERRUPTION_DEFAULTS` sets `min_duration: 0.5` (s of speech) and `min_words: 0` (STT-only) (`turn.py:117-125`); a `backchannel_boundary` of `(1.0, 1.0)` suppresses backchannel-classified overlap in the first/last 1.0s of each agent turn (`turn.py:108-114`). LiveKit's adaptive (ML) detector additionally classifies overlapping speech as interruption vs backchannel using a probability `threshold = 0.5` over a minimum of 2 consecutive 25ms frames (`MIN_INTERRUPTION_DURATION_IN_S = 0.025 * 2`, `defaults.ts:7-8`), sending a 0.5s audio prefix for context (`AUDIO_PREFIX_DURATION_IN_S = 0.5`, `defaults.ts:10`).

**Prior-art divergence.** Vapi gates on **STT transcript confidence** (a single Interrupt threshold Y). LiveKit gates on **VAD speech duration + word count**, and optionally an **ML overlap classifier** (interruption vs backchannel) at prob 0.5 — a richer model that distinguishes "I want to talk" from "uh-huh". Pipecat triggers interruption from a VAD user-turn-start strategy (`VADUserTurnStartStrategy`) and leaves confidence tuning to the VAD/turn config.

**Implication for Syrinx.** A bare VAD energy spike is too trigger-happy. Gate interruption behind at least a minimum sustained duration (~0.5s) and, where transcripts are available, a confidence floor. A backchannel classifier is the higher-grade option for natural overlap. Untriggered "almost interruptions" still need recovery — see [[BARGE-09-false-interruption-recovery]].

Links: [[BARGE-09-false-interruption-recovery]] [[BARGE-02-interruption-sequence]] [[TURN-01-vad-state-machine-hysteresis]] [[STT-03-confidence-filtering]]
