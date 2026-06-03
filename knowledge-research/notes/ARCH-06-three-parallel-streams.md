---
id: ARCH-06
title: The three-parallel-streams model + predict-and-scrap (Vapi)
domain: ARCH
tags: [parallel, streams, endpointing, predict-and-scrap, coordination]
sources: [vapi-pipeline-1, vapi-pipeline-2, el-orchestration, modal-v2v]
code_refs: [pipecat/src/pipecat/pipeline/parallel_pipeline.py:24, agents/livekit-agents/livekit/agents/voice/agent_activity.py:1872]
---

**Claim (one line):** Vapi decomposes the engine into **three concurrent streams** — Audio Input (20ms VAD/preprocess), Transcription (streaming partials), Response Generation (LLM on partials with **predict-and-scrap**) — and the hard part is coordinating them.

**Detail.** The three streams (`vapi-pipeline-1.md:20-33`): (1) **Audio Input** processes 20ms chunks — VAD, preprocessing, real-time buffering. (2) **Transcription** streams partials ("I need to…"→"…schedule…"→"…Tuesday"), each fed downstream immediately. (3) **Response Generation**: LLM works on partial info; an **endpointing model predicts when the user finished** → send the complete utterance to the LLM; "if the model is wrong and the user continues, scrap that LLM request and start a new one with the updated transcript" — the **"predict and scrap"** method, also called **greedy inference** ("the user never hears the scrapped attempt") (`vapi-pipeline-2.md:46-47`). ElevenLabs confirms the speculative variant: predicting end-of-speech "results in multiple LLM generation requests with the same conversation context within a single turn" (`elevenlabs-orchestration-engine.md:17`).

LiveKit implements predict-and-scrap as **preemptive generation**: `on_preemptive_generation` fires a `_generate_reply(... schedule_speech=False)` on an interim transcript, gated by `max_speech_duration` and `max_retries`, and `_cancel_preemptive_generation()` scraps it if the verdict changes (`agents/.../agent_activity.py:1872-1919,1883`). Pipecat's `ParallelPipeline` is the literal multi-stream construct: N sub-pipelines run concurrently from one source, each wrapped in its own source/sink (`pipecat/.../parallel_pipeline.py:24-76`).

**Prior-art divergence.** Modal *rejects* the streaming-partials premise for its STT: VAD-gated segment-then-transcribe (Parakeet) beat streaming STT on final-transcript time, and "the only thing that matters for total v2v latency is the final transcript time" (`modal-one-second-voice-to-voice.md:33`). So stream #2's value (live partials) is mainly to feed *speculative* generation (stream #3), not latency per se — if you don't speculate, partials may not be worth it.

**Implication for Syrinx.** Run input/transcription/generation concurrently and decide explicitly whether to speculate: predict-and-scrap buys perceived latency but costs wasted LLM calls. If we don't speculate, Modal's finding says streaming partials add little — segment-then-transcribe may be simpler and faster to final transcript.

Links: [[ARCH-04-event-driven-lifecycle]] [[ARCH-05-batch-vs-streaming-vs-s2s]] [[TURN-03-semantic-vs-timeout-endpointing]] [[LAT-09-preemptive-generation]] [[STT-02-partial-final-lifecycle]]
