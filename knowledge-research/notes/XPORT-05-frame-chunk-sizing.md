---
id: XPORT-05
title: Frame / chunk sizing on the wire (10–50 ms)
domain: XPORT
tags: [framing, chunk, ptime, latency, interruption]
sources: [deepgram-ebook, vapi-pipeline-1, modal-v2v]
code_refs: [pipecat/src/pipecat/transports/base_transport.py:69, pipecat/src/pipecat/transports/base_output.py:134, pipecat/src/pipecat/transports/smallwebrtc/transport.py:94, agents/livekit-agents/livekit/agents/voice/room_io/_output.py:52]
---

**Claim (one line):** Stream audio in small fixed frames of 10–50 ms; the framework re-chunks long TTS frames to this size so interruptions can cut playback mid-utterance.

**Detail.** Deepgram: "Audio should be streamed in small, consistent frames rather than buffered in large chunks. Frame sizes in the **20–50 millisecond** range strike a balance between reactivity and network efficiency. Smaller frames increase responsiveness but raise overhead" (deepgram-ebook line 509–513). Vapi cites **20 ms chunks** (vapi-pipeline-1). The clones converge on a 10 ms quantum: Pipecat's output transport buffers in **`audio_out_10ms_chunks = 4`** by default → a **40 ms** write unit, computed as `audio_bytes_10ms = (sample_rate/100)*channels*2; chunk_size = audio_bytes_10ms * 4` (`base_transport.py:69`, `base_output.py:134`). The base output explicitly re-chunks: long TTS frames are split because "this helps with interruption handling" (`base_output.py:83,133`). Pipecat's WebRTC `RawAudioTrack` works in a hard **10 ms** grain — `_samples_per_10ms = sample_rate*10//1000` and `add_audio_bytes` rejects input that isn't a multiple of 10 ms (`transport.py:94,113`). LiveKit's room output builds an `AudioByteStream` with **`samples_per_channel = sample_rate // 20`** = **50 ms** frames (`_output.py:52`).

**Prior-art divergence.** Pipecat output default 40 ms (4×10 ms), WebRTC grain 10 ms; LiveKit room output 50 ms. Smaller = faster barge-in response and finer interruption granularity but more packets/CPU; LiveKit's 50 ms favors efficiency, Pipecat's 10 ms WebRTC grain favors interruption precision. All sit inside Deepgram's 20–50 ms band (Pipecat's 40 ms is the midpoint).

**Implication for Syrinx.** Default to ~20 ms egress frames (Vapi/Deepgram sweet spot); keep the re-chunk-on-interruption behavior so barge-in can drop the queue at a 10–20 ms boundary rather than waiting out a whole sentence.

Links: [[XPORT-06-jitter-buffer-playback]] [[XPORT-03-resampling-ingress-egress]] [[BARGE-02-interruption-sequence]]
