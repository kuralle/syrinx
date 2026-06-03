---
id: TTS-07
title: Output buffering — a small (~100ms) jitter buffer prevents playback gaps
domain: TTS
tags: [jitter-buffer, buffering, playback, frame-size]
sources: [deepgram-ebook]
code_refs: [voice-ai/api/assistant-api/internal/channel/telephony/internal/telnyx/internal/audio_processor.go:118, pipecat/src/pipecat/services/tts_service.py:423]
---

**Claim (one line):** Streamed TTS audio is buffered *just enough* (~100ms) before playback to absorb network jitter without adding perceptible delay — too little gaps, too much lags.

**Detail.** Deepgram: *"synthesized speech should be streamed incrementally and buffered just enough to prevent playback gaps. A short jitter buffer around 100 milliseconds is usually sufficient to smooth minor network variation without adding perceptible delay"* (deepgram-ebook L516-518). Frames themselves should be small — *"20-50 millisecond range"* (L511-512). Rapida implements both sides: input audio is accumulated and drained only past a threshold (`bufferAndSendInput` → `DrainIfReady(InputBufferThreshold)`), and output µ-law is buffered and emitted in fixed **20ms** chunks (`OutputChunkSize = MulawBytesPerMs(8) × 20`) (audio_processor.go:118-120, :28-29). Pipecat sizes its TTS output chunks from a `CHUNK_SECONDS` constant: `int(self.sample_rate * CHUNK_SECONDS * 2)` bytes (16-bit) (tts_service.py:423), and can pad with trailing silence after `TTSStoppedFrame` to keep the stream continuous (tts_service.py:825-829).

**Prior-art divergence.** Deepgram names a concrete **~100ms** jitter target at the playback boundary. Rapida/Pipecat express buffering as **fixed 20ms egress chunks** plus drain thresholds rather than a single named jitter value — the jitter absorption lives in the transport/playout layer (see [[XPORT-06-jitter-buffer-playback]]), while the TTS layer just guarantees a steady chunk cadence. LiveKit defends the buffer from the producer side with its remaining-audio watermark ([[TTS-04-rtf]]).

**Implication for Syrinx.** Emit TTS in ~20ms chunks and hold ~100ms at the playout boundary. Keep the producer ahead (RTF < 1) so the buffer is the *only* thing absorbing jitter, not the synthesizer.

Links: [[TTS-04-rtf]] [[TTS-06-output-encoding-mulaw]] [[XPORT-06-jitter-buffer-playback]] [[wiki/tts-map]]
