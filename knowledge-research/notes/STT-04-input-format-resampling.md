---
id: STT-04
title: STT socket input format — encoding, sample rate, and resampling to it
domain: STT
tags: [encoding, sample-rate, resampling, linear16, mulaw]
sources: [deepgram-ebook, diagrams]
code_refs: [pipecat/src/pipecat/services/deepgram/stt.py:569, voice-ai/api/assistant-api/internal/transformer/deepgram/deepgram.go:50, pipecat/src/pipecat/services/openai/stt.py:609]
---

**Claim (one line):** The STT socket is opened with an explicit `encoding` + `sample_rate`, and audio whose rate differs (telephony 8 kHz, browser 48 kHz) must be resampled to the declared rate before it is sent, or the recognizer silently degrades.

**Detail.** Deepgram's UX chapter: telephony uses "8 kHz mono µ-law or A-law PCM, while browsers and mobile devices commonly support 16 or 48 kHz PCM" (deepgram-ebook:514-516). The socket is parameterized: Pipecat sets `encoding="linear16"` by default and writes `encoding`, `channels`, `multichannel`, and `sample_rate` (= `self.sample_rate`) into the connect query (`deepgram/stt.py:300, 569-572`). Rapida hard-codes `Encoding: "linear16"` (`deepgram.go:21-23`) and opens the live socket at `SampleRate: 16000, Channels: 1` (`deepgram.go:51-66`). Crucially, the **declared rate must match the bytes**: Pipecat's base STT sets `self._sample_rate = self._init_sample_rate or frame.audio_in_sample_rate` (`stt_service.py:303`), so a streaming provider trusts the pipeline rate. Where the provider's required rate differs, services resample explicitly — e.g. OpenAI/Whisper resamples every chunk: `await self._resampler.resample(audio, self.sample_rate, OPENAI_SAMPLE_RATE)` before upload (`openai/stt.py:609`), and the realtime path is "automatically resampled to 24 kHz" (`openai/stt.py:446`). Deepgram-style streaming providers do *not* resample in-plugin; they declare `sample_rate` and require the transport to deliver matching PCM.

**Prior-art divergence.** Two strategies: (a) **declare-and-match** — streaming providers (Deepgram in Pipecat/Rapida, Soniox which writes `"sample_rate": self.sample_rate` into its connect config — default `None`, so it trusts the pipeline rate, `soniox/stt.py:267,527`) push the rate into the socket params and assume upstream PCM already matches; (b) **resample-in-plugin** — batch/Whisper providers force a fixed model rate (OpenAI 24 kHz) and resample each buffer. Telephony µ-law decode/resample happens in the serializer layer, not the STT plugin.

**Implication for Syrinx.** Own one resample boundary: convert transport PCM (8/48 kHz) to the STT socket's declared rate (typically 16 kHz) before the socket, and assert the declared `sample_rate` param equals the bytes we send.

Links: [[STT-01-streaming-vs-batch]] [[STT-09-streaming-native-vs-whisper]] [[XPORT-02-canonical-pcm-sample-rates]] [[XPORT-04-mulaw-telephony-path]]
