---
id: BARGE-08
title: Spoken-word truncation — LiveKit (speaking-rate) vs Pipecat (PTS-gated frames)
domain: BARGE
tags: [word-timestamps, playout, speaking-rate, pts, mechanism-compare]
sources: [vapi-pipeline-2]
code_refs: [agents/livekit-agents/livekit/agents/voice/transcription/synchronizer.py:344, pipecat/src/pipecat/transports/base_output.py:379]
---

**Claim (one line):** LiveKit and Pipecat both write only the *played* prefix to history, but LiveKit estimates it from playback-clock × speaking-rate while Pipecat gates word frames by presentation timestamp — two distinct mechanisms for the same goal Vapi states as "which words the user actually heard."

**Detail.** **LiveKit** has no per-word audio offset from the TTS; it *estimates* the boundary. Its synchronizer walks the response word-stream and advances `forwarded_text` to match elapsed playback time, using the measured speaking rate: `target_len = annotated.accumulate_to(elapsed)` then forwards `pushed_text[forwarded_len:target_len]` (`synchronizer.py:344-359`); if no annotated rate, it falls back to an estimated speaking-rate accumulator (`synchronizer.py:361-365`). On interruption `synchronized_transcript` returns this elapsed-derived prefix ([[BARGE-05-context-reconstruction-vapi]]). **Pipecat** instead attaches a presentation timestamp (`pts`) to each frame; the output transport routes any `pts`-bearing frame to `handle_timed_frame` (`base_output.py:379-380`) which queues it on a clock task keyed by `(pts, …)` (`base_output.py:616`). Word-level `TTSTextFrame`s thus reach the assistant aggregator only when their playout time arrives, so on interruption the aggregation already contains exactly the spoken words (`llm_response_universal.py:1880`). Vapi's described mechanism — TTS-provider word timestamps — is closest to a third variant: trust the provider's per-word offsets directly (vapi-pipeline-2 line 56).

**Prior-art divergence.** Three mechanisms, one goal: (a) **Vapi** = trust TTS word timestamps; (b) **LiveKit** = playback clock × speaking-rate estimate (provider-agnostic, approximate); (c) **Pipecat** = PTS-scheduled word frames on a media clock (exact to the frame, needs a clock task). LiveKit's is robust to TTS providers that don't emit word timing; Pipecat's is exact but couples transcription to the audio clock.

**Implication for Syrinx.** If our TTS emits reliable word timestamps, the Vapi/Pipecat exact path is best. If not, LiveKit's speaking-rate estimate is the fallback that needs no provider support — accept ±a word or two of truncation error.

Links: [[BARGE-05-context-reconstruction-vapi]] [[TTS-11-word-timestamps]] [[OBS-04-per-stage-latency-metrics]]
