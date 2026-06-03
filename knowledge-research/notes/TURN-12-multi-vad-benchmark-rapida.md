---
id: TURN-12
title: Multi-VAD provider selection with benchmarked trade-offs — Rapida's Silero vs TEN vs FireRed comparison
domain: TURN
tags: [vad, silero, ten-vad, firered, rapida, benchmark, throughput, latency, turn-detection]
sources: []
code_refs: [voice-ai/api/assistant-api/internal/vad/vad.go:27, voice-ai/api/assistant-api/internal/vad/BENCHMARK_COMPARISON.md]
---

**Claim (one line):** Rapida ships three selectable VAD providers backed by the only quantitative head-to-head VAD benchmark among the OSS clones (selectable VADs alone are not unique — Pipecat ships ≥3 too; the benchmark data is) — Silero for maximum throughput (243× RT), TEN VAD for best turn-taking latency (30 µs init, 1 ms inference), and FireRed for Chinese/multilingual accuracy with the most configurable state machine.

**Detail.** Rapida's VAD module (`vad.go:27-44`) provides a factory `GetVAD()` that selects among three providers based on `microphone.vad.provider` options: `silero_vad` (default), `ten_vad` (Agora's C library), and `firered_vad` (DFSMN ONNX from FunASR). All input audio is 16 kHz LINEAR16 mono. The benchmark data (BENCHMARK_COMPARISON.md, Apple M1 Pro, Go 1.25) quantifies the trade-offs:

**Throughput:** Silero leads at **243× real-time** (3.89M samples/sec) vs TEN at 54× vs FireRed at 22×. All three are comfortably real-time for production — the worst performer still has 22× headroom for a single 16 kHz stream.

**Per-chunk latency (80 ms production chunk):** Silero **400 µs** (0.5% of budget), TEN 1.04 ms (1.3%), FireRed 3.66 ms (4.6%). Silero's minimal allocation count (2 allocs vs 6 for TEN vs 114 for FireRed) makes it the most CPU-cache-friendly.

**Init time:** TEN VAD at **30 µs** is nearly free (prebuilt C lib, 313 KB); Silero at 121 ms loads ONNX runtime; FireRed at 16.3 ms loads its ONNX + fbank + FFT pipeline.

**Detection granularity:** FireRed operates at **10 ms** frame shift (3× finer than Silero's 32 ms, 1.6× finer than TEN's 16 ms), giving it the best barge-in detection resolution. FireRed also has the richest state machine: configurable threshold, min speech duration, min silence duration, and smoothing window — vs Silero/TEN which expose only a threshold.

**Memory:** TEN VAD at **2.7 KB/chunk** is the lightest; Silero at 4.0 KB is close; FireRed at 1,329 KB/chunk is an outlier due to its ONNX runtime + feature extraction allocations. This matters for high-concurrency deployments.

**Qualitative accuracy:** Silero is the "industry standard" deployed in LiveKit, Pipecat, and Daily. TEN claims better precision-recall on LibriSpeech/GigaSpeech/DNS. FireRed's DFSMN model is trained on Chinese+English — Rapida explicitly recommends it for Chinese/multilingual use cases.

The benchmark also provides scaling data: parallel 8-stream Silero at 3.7 ms vs TEN at 18 ms vs FireRed at 44.7 ms; sequential 100 × 80 ms chunks at 39.5 ms (Silero) to 440 ms (FireRed).

**Prior-art divergence.** Pipecat also ships multiple selectable local VAD analyzers (`pipecat/src/pipecat/audio/vad/`: `SileroVADAnalyzer` silero.py:129, `AICVADAnalyzer` aic_vad.py:19, `KrispVivaVadAnalyzer` krisp_viva_vad.py:34), so multi-VAD selection is not unique to Rapida. What is unique is Rapida's quantitative benchmarking — no other clone (pipecat/livekit) ships head-to-head VAD performance data for the voice-engine use case. The recommendation matrix (default conversational AI → TEN; max throughput → Silero; Chinese/multilingual → FireRed; max configurability → FireRed) gives a decision framework the other clones lack. Silero's known end-of-utterance delay ("hundreds of ms") vs TEN's claimed faster speech→silence detection is noted but not quantitatively compared in the benchmark — the detect-to-silence latency claims are qualitative only.

**Implication for Syrinx.** Don't hard-code one VAD. Use Rapida's benchmark as a starting reference, select per deployment profile (throughput-optimized vs latency-optimized vs multilingual), and run our own VAD benchmark on the target deployment hardware — M1 Pro results don't transfer to x86 server CPUs or edge devices. TEN VAD's 30 µs init time is valuable for cold-start-sensitive deployments; FireRed's 10 ms granularity is valuable for aggressive barge-in ([[BARGE-06-confidence-gated-interruption]]).

Links: [[TURN-01-vad-state-machine-hysteresis]] [[TURN-02-dynamic-baseline-percentile]] [[BARGE-06-confidence-gated-interruption]] [[REL-11-vad-separate-process-respawn]]
