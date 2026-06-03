---
id: REL-12
title: Sample-rate and encoding mismatch as a failure mode — choppy/distorted audio
domain: REL
tags: [sample-rate, encoding, mismatch, failure-mode, resampling, telephony, pcm]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/audio/resamplers/soxr_stream_resampler.py:30, pipecat/src/pipecat/audio/utils.py:40]
---

**Claim (one line):** A mismatch between the sample rate or encoding the sender produces and the receiver expects creates choppy, distorted, or pitch-shifted audio — a failure so common Deepgram catalogues it explicitly, and the fix is a single canonical resample boundary at ingress.

**Detail.** Deepgram's failure-mode catalogue lists "Choppy, Distorted, or Unnatural Audio" as originating in "playback buffering, encoding mismatches, or network instability" with the inspection checklist: "Consistency between audio formats across the pipeline and whether playback strategies introduce unnecessary buffering" (deepgram-ebook ~2060–2068). The root cause is mechanical: audio encoded as 8 kHz µ-law but decoded as 16 kHz PCM doubles the pitch and halves duration; audio at 48 kHz fed to a 16 kHz STT socket gets downsampled by dropping ⅔ of samples, losing high frequencies and creating aliasing. The Deepgram telephony section emphasizes: "Encoding formats should match the environment. Telephony typically uses 8 kHz mono µ-law or A-law PCM, while browsers and mobile devices commonly support 16 or 48 kHz PCM" (deepgram-ebook ~510–516).

The canonical fix is a **single resample boundary at the transport edge**. Pipecat's architecture enforces this: `soxr_stream_resampler.py` provides stateful soxr resampling with quality modes VHQ/HQ/MQ/LQ/QQ (`soxr_stream_resampler.py:30`), and `audio/utils.py:40` provides `create_stream_resampler()` as a factory. LiveKit's room I/O lazily builds a per-call `rtc.AudioResampler` on first frame if the track rate ≠ pipeline rate — a local `resampler` in `_input.py`'s `_resample_frames()` (`_input.py:368–386`). But if any stage *after* the transport resamples without matching quality or if two stages cascade-resample (transport→STT plugin, then STT plugin→provider), the pipeline degrades. The architecture rule ([[XPORT-03-resampling-ingress-egress]]) is: one resample boundary, stateful, matching the STT/TTS declared rate.

A secondary encoding mismatch is the **µ-law passthrough trap**: if the provider speaks µ-law natively but the pipeline transcodes to PCM and back — or worse, treats µ-law bytes as PCM samples — the result is loud static. Deepgram advises: "skip transcoding when the provider speaks µ-law natively" (ebook ~719), but Pipecat's pipeline is PCM-only and always decodes µ-law at the Twilio serializer edge (`ulaw_to_pcm` in `deserialize()`, `twilio.py:256`), which is correct *as long as the STT socket is told it's receiving PCM, not µ-law*.

**Prior-art divergence.** All clones converge on "resample at the edge, PCM internally." Cloudflare's telephony bridge does inline linear-interpolation resampling (faster, lower quality) vs Pipecat/LiveKit's soxr (higher quality). The divergence that causes failures is not "which resampler" but "did we inform the STT/TTS socket of the correct encoding and rate in the connect handshake" — a handshake mismatch (PCM declared, µ-law sent) produces exactly the symptoms Deepgram describes.

**Implication for Syrinx.** Assert at connect-time: `declared_rate == actual_rate` for both STT and TTS sockets. Instrument for format mismatches as a distinct telemetry metric. Never cascade-resample (two resamplers in series). If a TTS provider requires a different rate than the transport, resample at the TTS plugin edge — not by informing the transport of the wrong rate.

Links: [[XPORT-03-resampling-ingress-egress]] [[XPORT-02-canonical-pcm-sample-rates]] [[XPORT-04-mulaw-telephony-path]] [[STT-04-input-format-resampling]] [[REL-10-failure-mode-catalog]]
