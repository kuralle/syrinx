---
id: BARGE-04
title: Flushing queued audio buffers on interruption
domain: BARGE
tags: [buffer, flush, playback, queue, uninterruptible]
sources: [vapi-pipeline-2, deepgram-ebook]
code_refs: [pipecat/src/pipecat/transports/base_output.py:548, pipecat/src/pipecat/services/tts_service.py:918, pipecat/src/pipecat/utils/frame_queue.py:82]
---

**Claim (one line):** Because the LLM/TTS run ahead of real-time playback, seconds of synthesized audio sit queued; on interruption those buffers must be cleared or the agent keeps talking after it was told to stop.

**Detail.** Vapi names this step 4 of the sequence — "Audio buffers cleared to prevent glitchy playback" (vapi-pipeline-2 line 53) — and motivates it: "LLMs generate faster than we can speak, so audio is often queued" (line 56). Deepgram requires confirmation that the flush completed: "Playback confirmation events are essential to ensure buffers are reset cleanly before the next response begins" (deepgram-ebook ~line 580 / 743-744). Pipecat's flush keeps two queues distinct: on `InterruptionFrame` the output sender cancels the audio task and recreates it, but if uninterruptible frames are queued it instead `reset()`s only the interruptible items (`base_output.py:548-554`); the per-chunk `_audio_buffer` bytearray is zeroed on bot-stopped-speaking (`base_output.py:684`). The TTSService's serialization queue uses the same selective drop: "Drops non-UninterruptibleFrame items while keeping uninterruptible ones (e.g. FunctionCallResultFrame)" (`tts_service.py:916-918`, via the `reset()` primitive in `frame_queue.py:82-93`).

**Prior-art divergence.** Pipecat draws a hard line between flushable audio and *uninterruptible* frames (EndFrame, StopFrame, tool results) that survive the flush — a refinement Vapi's prose doesn't mention. Vapi clears unconditionally ("buffers cleared"). Deepgram emphasizes the playback-confirmation event so downstream state resets cleanly, which neither Vapi nor the others surface as a distinct step.

**Implication for Syrinx.** Our TTS egress queue must support a synchronous flush, and the flush must distinguish "audio to drop" from "control frames that must still be delivered." Emit a playback-reset confirmation before accepting the next response so state doesn't desync.

Links: [[BARGE-02-interruption-sequence]] [[BARGE-05-context-reconstruction-vapi]] [[TTS-03-sentence-aggregation]] [[XPORT-06-jitter-buffer-playback]]
