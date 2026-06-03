---
id: ARCH-03
title: System vs data frame ordering — the priority queue that makes interruption instant
domain: ARCH
tags: [frames, ordering, priority-queue, interruption, barge-in]
sources: [vapi-pipeline-2, deepgram-ebook]
code_refs: [pipecat/src/pipecat/processors/frame_processor.py:119, pipecat/src/pipecat/processors/frame_processor.py:996]
---

**Claim (one line):** Pipecat gives **SystemFrames strict priority over DataFrames inside every processor** via a two-tier priority queue + a separate processing task, so an interruption/VAD event jumps the queue ahead of any buffered audio/text — the mechanism behind <100ms barge-in.

**Detail.** Each `FrameProcessor` owns a `FrameProcessorQueue(asyncio.PriorityQueue)` that tags `SystemFrame` items `HIGH_PRIORITY=1` and everything else `LOW_PRIORITY=2`, with a monotonic counter to keep FIFO order *within* a priority band (`frame_processor.py:119-154`). Critically there are **two tasks**: the input-frame task pops the queue and, if the frame is a `SystemFrame`, processes it *immediately inline*; non-system frames are forwarded to a second `__process_queue` handled by a separate task (`frame_processor.py:996-1042`). So a `UserStartedSpeakingFrame` or `InterruptionFrame` (both SystemFrames, `frames.py:951,962`) overtakes queued `OutputAudioRawFrame`/`LLMTextFrame` DataFrames and is acted on without waiting for the data backlog to drain. This is the architectural enabler of Vapi's "barge-in must complete in under 100ms" sequence — VAD event → abort LLM → stop TTS → clear buffers (`vapi-pipeline-2.md:49-54`) — and Deepgram's `on_user_started_speaking(): cancel_active_action(); stop_tts_playback()` (`deepgram-voice-agent.parsed.md:649-652`). The semantic contract: DataFrames are "cancelled by user interruptions" while SystemFrames "are not affected by user interruptions" (`frames.py:96-112`). `UninterruptibleFrame` mixin marks DataFrames that must survive interruption (e.g. `EndFrame`, `FunctionCallResultFrame`) (`frames.py:136-147,715`).

**Prior-art divergence.** Vapi/Deepgram describe the *outcome* (instant barge-in) but not the mechanism; Pipecat is the only clone that encodes priority structurally in the queue. LiveKit achieves the same via a synchronous (non-cancellable) `on_end_of_turn` hook plus explicit `interrupt()` and preemptive-generation cancellation (`agents/.../agent_activity.py:1268,1921-1930`) rather than a frame priority queue.

**Implication for Syrinx.** Endpointing/VAD/interruption signals must ride a higher-priority path than audio/text data inside whatever queue our stages use. If everything shares one FIFO, a TTS backlog will delay barge-in past the 100ms budget. A two-band queue (system vs data) per stage is the minimal correct design.

Links: [[ARCH-02-frame-taxonomy]] [[ARCH-04-event-driven-lifecycle]] [[BARGE-02-interruption-sequence]] [[TURN-01-vad-state-machine-hysteresis]]
