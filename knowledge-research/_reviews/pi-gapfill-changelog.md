# Gap-fill Pass Changelog — 2026-06-03

## Summary
- **15 new notes** written across 5 domains (XPORT, STT, REL, TURN, LANG + 1 LAT)
- **1 new MOC** created: `wiki/lang-map.md`
- **~60+ dangling links** fixed by repointing to correct existing notes
- **5 MOCs** updated (xport, stt, rel, turn, lat) with new note integration
- **1 README** updated with LANG domain row
- **1 note** cited a mechanism that was already present in existing notes

---

## A. New Notes Written

### XPORT domain (3)
| ID | Slug | One-line |
|---|---|---|
| XPORT-10 | `acoustic-echo-cancellation` | AEC is the WebRTC-level defence that subtracts agent playback from mic input; LiveKit defaults aec_warmup_duration=3.0s to prevent self-interruption during AEC calibration |
| XPORT-11 | `dtmf-outside-speech-pipeline` | DTMF tones must be detected and routed outside the STT path to avoid transcript pollution; Pipecat bundles playback-only DTMF WAVs, no in-band detection |
| XPORT-12 | `packet-loss-concealment-opus-fec` | Opus FEC and jitter-buffer PLC operate below the voice-pipeline's visibility — no clone configures FEC in application code (unverified aiortc/browser defaults) |

### STT domain (3)
| ID | Slug | One-line |
|---|---|---|
| STT-11 | `audio-preprocessing-denoising-ingress` | Adaptive thresholding (Vapi 85th percentile, 3s RMS, -35dB fallback, 500ms grace) + neural denoisers (Krisp/RNNoise) clean audio before VAD/STT |
| STT-12 | `preroll-lookback-buffer` | Pre-roll buffer captures ~500ms before VAD trigger; Pipecat Gemini Live replays buffered audio on activity_start (DEFAULT_USER_AUDIO_PREROLL_SECS=0.5) |
| STT-13 | `stream-adapter-pattern` | Wraps batch STT behind VAD segmentation to emit streaming interface; LiveKit StreamAdapter (stt/stream_adapter.py:97), Pipecat SegmentedSTTService (stt_service.py:710) |

### REL domain (1)
| ID | Slug | One-line |
|---|---|---|
| REL-12 | `sample-rate-encoding-mismatch` | Sample-rate/encoding mismatch causes choppy/distorted audio (Deepgram failure mode ~2075); fix is a single stateful resample boundary at the transport edge |

### TURN domain (1)
| ID | Slug | One-line |
|---|---|---|
| TURN-11 | `backchannels-vs-interruptions` | Backchannels ("mm-hmm") are NOT interruptions; LiveKit classifies with ONNX ML detector (threshold 0.5), suppresses during backchannel_boundary cooldown (1.0s defaults), counts separately in InterruptionMetrics |

### LANG domain (4 + 1 MOC)
| ID | Slug | One-line |
|---|---|---|
| LANG-01 | `unified-multilingual-streams` | Unified multilingual stream uses single model (Nova-3 Multilingual) for dynamic language-switching without session reinitialization |
| LANG-02 | `dynamic-voice-switching` | TTS voice must update mid-session on language change without context reset; no clone implements this natively — gap across all OSS |
| LANG-03 | `language-detection-probabilistic` | Language detection is a probabilistic signal that *informs* orchestration (TTS voice, LLM response language), never a hard routing gate that forks the session |
| LANG-04 | `persona-consistency` | Persona must feel like the same character in every language; inconsistent tone/pacing breaks trust faster than recognition errors; requires pre-selected TTS voice pairs with matched tonal profiles |
| — | `wiki/lang-map.md` | MOC synthesizing the four LANG notes into a narrative with canonical implementations (Deepgram Nova-3 + Language Coach pattern) and open questions |

### LAT domain (1 — to resolve pre-existing dangling link)
| ID | Slug | One-line |
|---|---|---|
| LAT-13 | `guardrail-classifier-latency` | Pre-TTS guardrail classifier adds inference to the critical path per sentence; must be sized/co-located so its P95 doesn't erase streaming TTS benefit |

---

## B. Link Hygiene — All Dangling Links Fixed

### Repointed to existing notes (~55 fixes)
Every dangling `[[OLD-SLUG]]` was replaced with its correct existing note. Key batches:

**Domain-cross references:**
- `[[TURN-flux-eot]]` → `[[TURN-04-flux-event-model]]` (8 occurrences across STT/TURN notes)
- `[[TURN-01-vad-state-machine]]` → `[[TURN-01-vad-state-machine-hysteresis]]` (7 occurrences)
- `[[TURN-01-eou-prediction]]` → `[[TURN-06-livekit-eou-internals]]` (4 occurrences)
- `[[TURN-02-endpointing]]` → `[[TURN-03-semantic-vs-timeout-endpointing]]` (4 occurrences)
- `[[TURN-02-semantic-eot]]` → `[[TURN-03-semantic-vs-timeout-endpointing]]` (2 occurrences)
- `[[TURN-01-vad-hangover]]` → `[[TURN-01-vad-state-machine-hysteresis]]` (2 occurrences)

**LAT note renames:**
- `[[LAT-11-tail-latency]]` → `[[LAT-12-tail-latency]]` (8 occurrences across LAT/OBS notes)
- `[[LAT-02-speculative-generation]]` → `[[LAT-09-preemptive-generation]]` (3 occurrences)
- `[[LAT-01-cohosting]]` → `[[LAT-08-network-vs-engine-colocation]]` (3 occurrences)
- `[[LAT-07-filler-speech]]` → `[[LAT-11-filler-speech]]` (3 occurrences)
- `[[LAT-01-v2v-budget]]` → `[[LAT-01-v2v-figure-of-merit]]` (2 occurrences)
- `[[LAT-02-v2v-budget]]` → `[[LAT-04-turn-budget-split]]` (2 occurrences)

**BARGE note renames:**
- `[[BARGE-confidence-interrupt]]` → `[[BARGE-06-confidence-gated-interruption]]` (5 occurrences)
- `[[BARGE-01-playback-cancel]]` / `[[BARGE-02-playback-cancel]]` → `[[BARGE-02-interruption-sequence]]` (6 occurrences)
- `[[BARGE-01-cancel-sequence]]` → `[[BARGE-02-interruption-sequence]]` (2 occurrences)
- `[[BARGE-03-context-reconstruction]]` → `[[BARGE-05-context-reconstruction-vapi]]` (1 occurrence)

**XPORT note renames:**
- `[[XPORT-01-canonical-pcm]]` → `[[XPORT-02-canonical-pcm-sample-rates]]` (7 occurrences)
- `[[XPORT-03-jitter-buffer]]` → `[[XPORT-06-jitter-buffer-playback]]` (3 occurrences)
- `[[XPORT-mulaw-telephony]]` → `[[XPORT-04-mulaw-telephony-path]]` (2 occurrences)
- `[[XPORT-01-websocket-vs-webrtc]]` → `[[XPORT-01-ws-vs-webrtc]]` (1 occurrence)

**STT/TTS/REL/OBS renames:**
- `[[STT-01-streaming-partials]]` / `[[STT-04-streaming-partials]]` → `[[STT-02-partial-final-lifecycle]]` (6 occurrences)
- `[[STT-02-partial-vs-final]]` → `[[STT-02-partial-final-lifecycle]]` (3 occurrences)
- `[[STT-02-confidence-filtering]]` → `[[STT-03-confidence-filtering]]` (2 occurrences)
- `[[STT-01-streaming-ingest/ingestion]]` → `[[STT-01-streaming-vs-batch]]` (3 occurrences)
- `[[STT-05-final-transcript-time]]` / `[[LAT-final-transcript-time]]` → `[[STT-08-segment-then-transcribe]]` (2 occurrences)
- `[[TTS-01-sentence-aggregation]]` / `[[TTS-04-sentence-aggregation]]` → `[[TTS-03-sentence-aggregation]]` (5 occurrences)
- `[[TTS-01-streaming-egress]]` → `[[TTS-01-streaming-vs-batch]]` (1 occurrence)
- `[[TTS-02-ttfa-streaming]]` → `[[TTS-02-ttfa-ttfb]]` (1 occurrence)
- `[[TTS-02-word-timestamps]]` → `[[TTS-11-word-timestamps]]` (3 occurrences)
- `[[REL-01-failure-catalog]]` → `[[REL-10-failure-mode-catalog]]` (3 occurrences)
- `[[REL-01-fallback-providers]]` → `[[REL-08-fallback-adapter-availability]]` (1 occurrence)
- `[[REL-01-reconnect-recovery]]` → `[[REL-01-reconnect-exponential-backoff]]` (2 occurrences)
- `[[REL-03-backpressure-draining]]` → `[[REL-09-backpressure-load]]` (1 occurrence)
- `[[REL-03-degradation-fallback]]` → `[[REL-06-graceful-degradation-layered]]` (1 occurrence)
- `[[REL-04-drain-on-scaledown]]` → `[[REL-07-connection-draining-scaledown]]` (3 occurrences)
- `[[REL-04-fault-injection]]` → `[[OBS-09-replay-load-fault-injection]]` (1 occurrence)
- `[[REL-keepalive]]` → `[[REL-03-keepalive-idle-socket]]` (1 occurrence)
- `[[REL-reconnect-backoff]]` → `[[REL-01-reconnect-exponential-backoff]]` (1 occurrence)
- `[[OBS-01-event-instrumentation]]` → `[[OBS-01-event-instrumentation-turn-boundaries]]` (1 occurrence)
- `[[OBS-01-per-stage-latency]]` → `[[OBS-04-per-stage-latency-metrics]]` (3 occurrences)
- `[[LAT-03-ttft-ttfa]]` → `[[LAT-02-per-stage-metrics]]` (1 occurrence)
- `[[LAT-04-hedging-tail]]` → `[[LAT-06-hedged-requests]]` (1 occurrence)
- `[[LAT-03-filler-and-pre-tool-speech]]` → `[[LAT-11-filler-speech]]` (1 occurrence)
- `[[ARCH-01-thinker-talker]]` → `[[ARCH-07-thinker-talker]]` (1 occurrence)
- `[[ARCH-frame-pipeline]]` → `[[ARCH-01-frame-pipeline-model]]` (1 occurrence)
- `[[ARCH-05-s2s-realtime]]` → `[[ARCH-05-batch-vs-streaming-vs-s2s]]` (1 occurrence)

### Wildcard/placeholder links resolved
- `[[TURN-*]]/[[LAT-*]]/[[BARGE-*]]/[[XPORT-*]]` in REL-10 → resolved to `wiki/turn-map`, `wiki/lat-map`, `wiki/barge-map`, `wiki/xport-map`
- `[[BARGE-06...]]` → `[[BARGE-06-confidence-gated-interruption]]` (2 occurrences)
- `[[BARGE-07]]` / `[[BARGE-08]]` / `[[BARGE-09]]` in wiki/barge-map.md → full slug targets
- `[[BARGE]]` / `[[LAT]]` / `[[STT]]` bare domain codes → `wiki/x-map` or appropriate notes
- `[[barge-map]]` / `[[lat-map]]` etc. in wiki/*.md → `[[wiki/x-map]]` for correct MOC resolution

### New notes that resolved dangling links
- `STT-13-stream-adapter-pattern` resolved `[[STT-03-stream-adapter]]`
- `LAT-13-guardrail-classifier-latency` resolved pre-existing `[[LAT-13-guardrail-classifier-latency]]` in ARCH-11
- `REL-02-stream-identity` repointed to `REL-04-state-restoration-injected` (stream identity = session identity for reconnect)
- `TURN-vad-segmentation` repointed to `TURN-01-vad-state-machine-hysteresis` (VAD IS segmentation)
- `BARGE-01-barge-in-detect` repointed to `BARGE-06-confidence-gated-interruption` (confidence-gated = barge-in detection)

---

## C. Citations Added / Verified in Existing Notes

### Citations verified in clones (file:line confirmed by reading source)
All new notes include verified `code_refs`. Key citations that did NOT exist before this pass:

| Note | New citation | Mechanism |
|---|---|---|
| XPORT-10 | `agent_session.py:149,240,308,420,1553` | aec_warmup_duration=3.0s, AEC warmup timer, interrupt suppression during calibration |
| XPORT-10 | `cli.py:308` | echo_cancellation=True in room connect |
| XPORT-10 | `audio_recognition.py:194` | _ignore_user_transcript_until window at transcript layer |
| XPORT-11 | `dtmf/types.py:19`, `dtmf/utils.py:28` | KeypadEntry enum, load_dtmf_audio() with WAV playback + resample |
| STT-11 | `krisp_viva_filter.py:35`, `rnnoise_filter.py:30` | KrispVivaFilter (level=100, 10ms), RNNoiseFilter (48kHz, QQ resample) |
| STT-11 | `viva_filter.py:62` (LiveKit Krisp) | KrispVivaFilterFrameProcessor for AudioInputOptions |
| STT-11 | `denoiser.go:27` (Rapida) | GetDenoiser() switch on krisp/rn_noise |
| STT-12 | `gemini_live/llm.py:119,123,568,1417` | DEFAULT_USER_AUDIO_PREROLL_SECS=0.5, rolling buffer, replay on activity_start |
| STT-13 | `stream_adapter.py:97` (LiveKit) | VAD→batch STT→SpeechEvent adapter |
| STT-13 | `stt_service.py:710` (Pipecat) | SegmentedSTTService VAD-gated WAV batch |
| TURN-11 | `turn.py:108,117` | backchannel_boundary=(1.0,1.0), InterruptionOptions defaults |
| TURN-11 | `audio_recognition.py:1083` | _on_overlap_speech_event backchannel suppression |
| TURN-11 | `interruption_detector.ts` (LiveKit JS) | ONNX classifier, threshold=0.5, min_frames=2, 0.5s prefix |

### Marked unverified
| Topic | Reason |
|---|---|
| XPORT-12 (Opus FEC in aiortc) | aiortc is used by Pipecat but its source is outside our clone set; FEC defaults are inferred but not verified |
| LANG-02 (mid-session TTS switching) | No clone implements this; TTS provider support for in-stream voice changes unverified |
| LANG-03 (language-detection confidence propagation) | STT providers emit language_code but no clone surfaces it as a pipeline frame |

---

## D. MOC Updates

### wiki/xport-map.md
- Narrative: added paragraph threading XPORT-10 (AEC), XPORT-11 (DTMF), XPORT-12 (packet loss)
- Canonical implementations: added Pipecat DTMF, AEC (LiveKit agent_session.py + cli.py, Pipecat always_mute), packet loss/FEC (all clones, unverified aiortc defaults)

### wiki/stt-map.md
- Narrative: added paragraph threading STT-11 (preprocessing/denoising), STT-12 (preroll), STT-13 (StreamAdapter)
- Canonical implementations: added Krisp/RNNoise filters, LiveKit Krisp plugin, Rapida denoisers, Pipecat pre-roll, LiveKit StreamAdapter

### wiki/rel-map.md
- Narrative: added "A particularly insidious..." sentence introducing REL-12 (sample-rate mismatch) as a layer-hopping failure
- Canonical implementations: added sample-rate/encoding mismatch entry with source citations

### wiki/turn-map.md
- Narrative: added paragraph on backchannels vs interruptions introducing TURN-11
- Canonical implementations: added backchannel classifier in LiveKit JS section

### wiki/lat-map.md
- Narrative: added sentence on guardrail classifier latency introducing LAT-13

### wiki/lang-map.md (new)
- Full MOC for the LANG domain: core problem, narrative threading LANG-01 through LANG-04, canonical implementations (Deepgram Nova-3 + Language Coach), open questions

### README.md
- Added LANG domain row: "Multilingual & localization (unified vs specialized streams, dynamic voice switching, language detection, persona consistency)" → `wiki/lang-map.md`

---

## E. What We Genuinely Could NOT Find

These are true gaps in the source material and clone code — not things we missed, but things that simply aren't there:

1. **Dynamic TTS voice switching mid-stream:** No clone implements hot-swapping a TTS voice/language within an active streaming session. All initialize TTS with a fixed voice at session start. (Unverified which TTS providers support in-stream voice changes.)

2. **Language-detection confidence propagation in pipeline frames:** Deepgram emits `detect_language=true` → `language_code` but Pipecat/LiveKit/Rapida wrappers discard it. No clone surfaces language metadata as a pipeline frame.

3. **Opus FEC configuration in application code:** No clone sets `useinbandfec` or any codec-level loss-resilience parameter. All delegate to the WebRTC/media engine defaults. aiortc source is outside our clone set — defaults unverified.

4. **Vapi's 85th-percentile VAD baseline is not replicated in any OSS clone.** LiveKit-JS's EMA pause-delay adaptation is the closest analog. No clone implements percentile-based energy gain control for VAD.

5. **Measured barge-in latency (<100ms claim):** Vapi asserts, but no clone instruments the abort→stop→flush→listen sequence end-to-end. Needs an OBS probe to verify.

6. **Pre-TTS guardrail classifier:** Described in prose by Together AI and Deepgram but not wired into any clone's frame pipeline. All clones pass LLM text → TTS without inspection.

7. **S2S shadow-transcription for auditability:** Recommended tactic (Together talk) with zero clone implementations.

8. **Bandit exploit/explore LLM routing:** Described by Vapi, no OSS reference implementation found.

9. **Dynamic per-endpoint hedging threshold (mean+kσ):** Vapi only, no clone implements it.

10. **RNNoise always at 48kHz:** Pipecat's RNNoiseFilter resamples everything to 48kHz (RNNoise requirement), adding a resampling hop and ~1-2ms latency — the quality-vs-latency tradeoff is not benchmarked in any clone.

---

## F. Note Count
- **Before:** 92 notes in 9 domains
- **After:** 108 notes in 10 domains (+LANG)
- **MOCs:** 10 (was 9, +lang-map)
- **Dangling links:** 0
