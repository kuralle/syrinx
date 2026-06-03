---
id: XPORT-03
title: Who resamples, where, and to what (ingress vs egress)
domain: XPORT
tags: [resample, soxr, ingress, egress, streaming]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/audio/resamplers/soxr_stream_resampler.py:30, pipecat/src/pipecat/audio/utils.py:170, agents/livekit-agents/livekit/agents/voice/room_io/_input.py:368, cloudflare-agents/voice-providers/twilio/src/index.ts:95]
---

**Claim (one line):** Resampling happens at the transport edges — ingress converts the link rate up to the pipeline's STT rate, egress converts the TTS rate down to the link rate — and streaming/real-time paths must use a *stateful* resampler to avoid click artifacts at chunk boundaries.

**Detail.** Pipecat keeps two resampler kinds: `SOXRAudioResampler` (file/batch) and `SOXRStreamAudioResampler` (`soxr_stream_resampler.py:30`) which "keeps an internal history which avoids clicks at chunk boundaries" using `soxr.ResampleStream` and clears state after `CLEAR_STREAM_AFTER_SECS = 0.2` of inactivity (line 27). Default quality is **`VHQ`** (very high quality) with a tunable down to `QQ` for lowest latency. The serializer owns the edge conversion: `TwilioFrameSerializer` instantiates `_input_resampler` and `_output_resampler` (`twilio.py:117–118`) and calls `ulaw_to_pcm(payload, 8000, pipeline_rate)` on ingress, `pcm_to_ulaw(audio, frame_rate, 8000)` on egress (`audio/utils.py:170,193`). LiveKit resamples per-frame at the room input only when the frame rate differs from the agent rate: `_resample_frames` lazily builds an `rtc.AudioResampler(input_rate=frame.sample_rate, output_rate=self._sample_rate)` (`_input.py:368–377`). Cloudflare's Twilio adapter hand-rolls linear-interpolation `resamplePCM` (8k↔16k) inline (`twilio/src/index.ts:95`) — lower quality than soxr but dependency-free in the Workers runtime.

**Prior-art divergence.** Pipecat = soxr VHQ stateful streaming. LiveKit = libav `AudioResampler`, lazily allocated, flushed at stream end (`_input.py:385`). Cloudflare = naive linear interpolation (acceptable for 8 kHz telephony, audibly worse for music/wideband). Deepgram's overriding rule is **avoid transcoding entirely** where the provider speaks µ-law natively (ebook line 719) — the cheapest resample is none.

**Implication for Syrinx.** Use a stateful streaming resampler (soxr-style) at edges, never a fresh stateless one per chunk; keep state for ~200ms and clear on silence. Where the STT/TTS provider accepts the link rate natively, skip the resample.

Links: [[XPORT-02-canonical-pcm-sample-rates]] [[XPORT-04-mulaw-telephony-path]] [[XPORT-05-frame-chunk-sizing]]
