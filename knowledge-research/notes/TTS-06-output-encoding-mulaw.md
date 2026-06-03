---
id: TTS-06
title: Output encoding & resampling — emit µ-law 8kHz for telephony, avoid transcoding
domain: TTS
tags: [encoding, mulaw, resampling, sample-rate, telephony]
sources: [deepgram-ebook, modal-v2v]
code_refs: [pipecat/src/pipecat/services/elevenlabs/tts.py:122, pipecat/src/pipecat/serializers/twilio.py:156, voice-ai/api/assistant-api/internal/channel/telephony/internal/telnyx/internal/audio_processor.go:130]
---

**Claim (one line):** TTS output must be encoded/resampled to match the transport — telephony wants **8kHz mono µ-law**, browsers want 16/48kHz PCM — and the cheapest path emits the target format natively to avoid a transcoding hop.

**Detail.** Deepgram: telephony is *"8 kHz mono µ-law or A-law PCM"* while *"browsers and mobile devices commonly support 16 or 48 kHz PCM"* (deepgram-ebook L514-516); the key optimization is *"format alignment. Avoid transcoding wherever possible... its TTS can emit µ-law audio directly consumable by telephony gateways. Eliminating format conversion removes unnecessary latency and reduces failure modes"* (deepgram-ebook L719-723). The clones expose the output format on the TTS request: ElevenLabs maps the requested sample rate to a format string (`pcm_8000`/`pcm_16000`/.../`pcm_24000`, default 24000) (elevenlabs/tts.py:122-149); Cartesia sends `output_format = {container, encoding, sample_rate}` with `encoding` defaulting to `pcm_s16le` (cartesia/tts.py:507-510, :243). **Two strategies for telephony µ-law:** (1) emit PCM and convert at the transport edge — Pipecat's Twilio serializer calls `pcm_to_ulaw(data, frame.sample_rate, 8000, resampler)` on egress (twilio.py:156-159), where `pcm_to_ulaw` resamples then `audioop.lin2ulaw` (audio/utils.py:193-209); (2) Rapida resamples TTS PCM to **µ-law 8kHz mono** in the telephony audio processor — `ProcessOutputAudio` → `adapter.ConvertOutput` → `resampler.Resample(...)` (Linear16kHz→Mulaw8kHz config) (audio_processor.go:130-141 → audio_adapter.go:43-45), chunked at `OutputChunkSize = 8 bytes/ms × 20ms` (audio_processor.go:28-29). (`g711` EncodeUlaw/DecodeUlaw is imported in the same adapter but only on the ambient-mix branch, audio_adapter.go:52-63 — not the main output path.) Modal's Kokoro accepts phonetic input and streams PCM; resampling happens at the WebRTC transport.

**Prior-art divergence.** Deepgram's pitch is **native µ-law emit** (no conversion at all). Pipecat and Rapida instead keep TTS in PCM and **resample/encode at the serializer/channel boundary** — more provider-agnostic but adds one `lin2ulaw` + resample step per frame. The native-emit path wins latency; the convert-at-edge path wins provider portability.

**Implication for Syrinx.** If a TTS supports native µ-law 8kHz output, request it directly for telephony legs to skip the resample+encode hop; otherwise resample at the transport edge (Pipecat/Rapida pattern) and keep the resampler streaming (stateful) to avoid block-boundary artifacts.

Links: [[TTS-07-output-jitter-buffer]] [[TTS-10-phoneme-input]] [[XPORT-02-canonical-pcm-sample-rates]] [[wiki/tts-map]]
