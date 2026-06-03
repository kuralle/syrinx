---
id: STT-06
title: WER and why STT errors are unrecoverable downstream
domain: STT
tags: [wer, accuracy, error-propagation, quality]
sources: [together-talk, deepgram-ebook]
code_refs: [voice-ai/api/assistant-api/internal/transformer/deepgram/internal/stt_callback.go:91]
---

**Claim (one line):** STT quality is measured as Word Error Rate (SOTA ~6%), and an STT mistake is unrecoverable — the LLM and TTS faithfully carry the wrong word forward, so STT is the one stage where an error can't be fixed later.

**Detail.** Together: "Quality = Word Error Rate. SOTA ~6% WER on open benchmarks. Errors are unrecoverable — LLM and TTS carry the mistake forward" (together-talk:15). This is the structural reason confidence-filtering ([[STT-03-confidence-filtering]]) and keyterm boosting ([[STT-05-keyterm-boosting]]) matter: there is no downstream repair. Deepgram qualifies the metric for production: "terminology accuracy and environmental robustness matter more than raw WER in production voice-led sales workflows" (deepgram-ebook:816-817) — i.e. WER on *your* entities beats benchmark WER. Together also separates STT quality from latency: latency = "time to complete transcript" after the user stops, run at P90 ~100ms (together-talk:16). The unrecoverability is why the final transcript is the contract handed to the agent verbatim: Rapida emits the final `alternative.Transcript` straight into a `SpeechToTextPacket` with its `Confidence` attached (`stt_callback.go:91-96`) — the confidence rides along so downstream can at least *know* how much to trust it, even though it can't re-derive the audio.

**Prior-art divergence.** Together treats WER as the headline quality metric; Deepgram argues entity/terminology accuracy under real noise is the production-relevant metric and WER alone is misleading. Both agree errors don't self-correct downstream. None of the clones attempt post-hoc transcript correction in the voice path — the mitigation is always upstream (boosting, confidence gates, better model).

**Implication for Syrinx.** Pick the STT by domain-entity accuracy, not benchmark WER. Pass confidence through to the agent context so low-confidence turns can trigger clarification rather than silent acting-on-garbage.

Links: [[STT-03-confidence-filtering]] [[STT-05-keyterm-boosting]] [[STT-07-provider-fallback]] [[STT-10-final-transcript-delivery]]
