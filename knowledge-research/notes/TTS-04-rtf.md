---
id: TTS-04
title: Real-time factor (RTF < 1) — synthesis must outrun playback
domain: TTS
tags: [rtf, latency, throughput, buffering]
sources: [together-talk]
code_refs: [agents/livekit-agents/livekit/agents/tts/stream_pacer.py:117]
---

**Claim (one line):** TTS must keep **real-time factor RTF < 1** — produce more than one second of audio per second of compute — or playback starves and the agent stutters.

**Detail.** Together: RTF = audio produced per second of processing; *"10s audio in 5s = RTF 0.5. Want RTF < 1 to avoid buffering"* (together-talk L27). RTF < 1 is what makes streaming output safe: once the first chunk plays, synthesis stays ahead of the play head so the jitter buffer never drains. No clone computes a named "RTF" constant, but LiveKit's `SentenceStreamPacer` operationalizes the same invariant from the consumer side: it tracks `remaining_audio = audio_start_time + audio_duration - curr_time` and only sends the next text batch when remaining audio falls below `min_remaining_audio` (default **5.0s**) (stream_pacer.py:117-135). That 5s cushion exists precisely because a transient RTF spike must not exhaust the buffer.

**Prior-art divergence.** Together states RTF as a model-selection criterion (pick a TTS whose RTF < 1 under load). LiveKit doesn't measure RTF but defends against RTF > 1 episodes with a remaining-audio watermark. Pipecat relies on the provider's streaming throughput plus a small output jitter buffer (see [[TTS-07-output-jitter-buffer]]).

**Implication for Syrinx.** Pick TTS models with RTF comfortably < 1 at our concurrency, and keep a remaining-audio watermark so a momentary RTF spike doesn't audibly gap.

Links: [[TTS-02-ttfa-ttfb]] [[TTS-07-output-jitter-buffer]] [[TTS-03-sentence-aggregation]] [[wiki/tts-map]]
