---
id: XPORT-02
title: Canonical PCM encoding and sample-rate choices (8k vs 16k vs 24k vs 48k)
domain: XPORT
tags: [pcm, linear16, sample-rate, encoding]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/frames/frames.py:855, pipecat/src/pipecat/transports/smallwebrtc/transport.py:468, cloudflare-agents/voice-providers/deepgram/src/index.ts:80, agents/livekit-agents/livekit/agents/utils/codecs/decoder.py:346]
---

**Claim (one line):** The internal carriage format is 16-bit signed mono PCM (linear16); the sample rate differs by stage — 16k for STT ingress, 24k for TTS egress, 48k for WebRTC, 8k for telephony.

**Detail.** Deepgram's guidance: telephony = **8 kHz mono µ-law/A-law PCM**; browsers/mobile = **16 or 48 kHz PCM** (deepgram-ebook line 514–516). The clones encode this as defaults. Pipecat's `StartFrame` defaults **`audio_in_sample_rate=16000`** and **`audio_out_sample_rate=24000`** (`frames.py:855`) — 16k is the STT-friendly input rate, 24k a common neural-TTS native rate (avoids an egress resample for many TTS models). All Pipecat audio is 16-bit: every util does `np.frombuffer(audio, dtype=np.int16)` and `setsampwidth(2)`. LiveKit's `AudioStreamDecoder` defaults **`sample_rate=48000, num_channels=1`** (`decoder.py:346`) — 48k is the WebRTC/Opus native rate. Cloudflare's Deepgram client defaults **`encoding="linear16", sampleRate=16000`** (`deepgram/src/index.ts:80–81`). Pipecat's WebRTC transport resamples ingress to a single mono int16 stream via `AudioResampler("s16", "mono", self._in_sample_rate)` (`transport.py:468`).

**Prior-art divergence.** Default egress rate diverges: Pipecat 24k, LiveKit 48k (Opus-native). 8k is reserved strictly for the telephony edge (see [[XPORT-04-mulaw-telephony-path]]); nobody runs the internal pipeline at 8k — they resample 8k→16k at ingress to protect STT accuracy (deepgram-ebook line 717 notes 8k "slightly increases recognition difficulty").

**Implication for Syrinx.** Standardize on int16 mono PCM internally; pick 16k in / 24k out as defaults; only touch 8k µ-law at the Twilio boundary.

Links: [[XPORT-03-resampling-ingress-egress]] [[XPORT-04-mulaw-telephony-path]] [[STT-01-streaming-vs-batch]]
