---
id: STT-09
title: Streaming-native encoders vs Whisper 30s-clip chunking
domain: STT
tags: [whisper, encoder, look-ahead, cached-activations, parakeet, flux]
sources: [together-talk, deepgram-ebook]
code_refs: [pipecat/src/pipecat/services/whisper/stt.py:207, pipecat/src/pipecat/services/deepgram/flux/base.py:241]
---

**Claim (one line):** Whisper was trained on fixed 30-second clips, so streaming it requires hacky chunking/padding/stitching; streaming-native encoders instead train with a small variable look-ahead (80ms–1s) and cache activations so stepping through audio frames does the heavy compute once.

**Detail.** Together: "Whisper (canonical) trained on 30s clips → too long → people build chunking/silence-padding/multi-call-stitching hacks. New NVIDIA-style models: encoder trained with variable look-ahead (80ms up to ~1s) instead of 30s, and caches activations so stepping through audio frames does the heavy compute once → real streaming" (together-talk:19). The chunking hack is visible in Pipecat's `WhisperSTTService`, which extends `SegmentedSTTService` (i.e. VAD-gates whole utterances, never streams) and runs the model offline per segment, filtering segments by `no_speech_prob` (`whisper/stt.py:207-211, 364-374`) — see [[STT-08-segment-then-transcribe]]. The streaming-native side is what Deepgram Flux exposes: a single conversational model that emits `Update`/`EagerEndOfTurn`/`EndOfTurn` continuously over one socket (`flux/base.py:97-108`), tuned by a small look-ahead-like `eot_threshold` (default 0.7) / `eager_eot_threshold` and an `eot_timeout_ms` (default 5000) opened directly in the query string (`flux/base.py:241-256`). Parakeet (Modal) and NVIDIA's encoders are the open-weights instances of this class.

**Prior-art divergence.** Whisper/OpenAI = batch encoder, must be wrapped in VAD segmentation; its 30s training horizon is a hard architectural mismatch for streaming. Streaming-native (Deepgram Nova/Flux, NVIDIA Parakeet/Canary) either stream partials or — counterintuitively — are *also* fast enough to win in segment-then-transcribe mode (Modal's Parakeet result, [[STT-08-segment-then-transcribe]]). The cached-activation property is what makes per-frame stepping cheap; Whisper has no such cache, so chunk overlap recomputes.

**Implication for Syrinx.** Prefer a streaming-native encoder (Nova-3/Flux/Parakeet). If we must use Whisper, accept it's segment-then-transcribe only and budget for chunk-stitching artifacts; don't pretend it streams.

Links: [[STT-01-streaming-vs-batch]] [[STT-08-segment-then-transcribe]] [[STT-02-partial-final-lifecycle]] [[TURN-04-flux-event-model]]
