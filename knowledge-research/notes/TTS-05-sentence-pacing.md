---
id: TTS-05
title: Sentence pacing — first sentence immediately, then batch against remaining audio
domain: TTS
tags: [pacing, batching, ttfa, interruption-waste, prosody]
sources: [together-talk]
code_refs: [agents/livekit-agents/livekit/agents/tts/stream_pacer.py:97]
---

**Claim (one line):** After splitting into sentences, send the **first sentence immediately** for low TTFA, then **batch later sentences** and flush only when the buffered audio is about to run low — trading a little latency for fewer wasted synthesis on interruptions and better cross-sentence prosody.

**Detail.** Naively forwarding every sentence the instant it completes wastes TTS work when the user barges in mid-response, and gives the TTS no cross-sentence context. LiveKit's `SentenceStreamPacer` solves both: `first_sentence` is sent immediately, then subsequent sentences are buffered and a batch is flushed only when generation has stopped **and** `remaining_audio <= min_remaining_audio` (default **5.0s**), with each batch capped at `max_text_length` (default **300** chars) (stream_pacer.py:97-148). The docstring states the intent directly: *"buffers sentences and decides when to flush based on remaining audio duration. This may reduce waste from interruptions and improve speech quality by sending larger chunks of text with more context"* (stream_pacer.py:20-29). The pacer polls audio progress every 0.2s while generating and otherwise sleeps up to `remaining_audio - min_remaining_audio` (stream_pacer.py:158-164).

**Prior-art divergence.** Pipecat does **not** pace at the sentence level — its `SimpleTextAggregator` forwards each completed sentence to the websocket as soon as it's detected ([[TTS-03-sentence-aggregation]]); backpressure/ordering is handled downstream by the audio-context sequencer, not by withholding text. So LiveKit optimizes for *less wasted synthesis + more context*, Pipecat for *minimum per-sentence latency*. LiveKit's pacer is opt-in (`text_pacing=True` on `StreamAdapter`), default off.

**Implication for Syrinx.** Send sentence 1 immediately; if our TTS bills per request or barge-in is frequent, adopt the LiveKit watermark (flush when buffered audio < ~5s, cap batch ~300 chars) to cut wasted synthesis without risking a playback gap.

Links: [[TTS-03-sentence-aggregation]] [[TTS-04-rtf]] [[TTS-08-interruptible-tts]] [[wiki/tts-map]]
