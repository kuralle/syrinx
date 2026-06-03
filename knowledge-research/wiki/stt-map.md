# STT — Speech-to-Text Ingestion (Map of Content)

## Core problem
STT is the voice engine's "ears": it turns the user's streamed audio into the **final transcript** that is handed to the agent. It is the one pipeline stage whose errors are *unrecoverable* — the LLM and TTS faithfully carry any mistake forward — so the domain optimizes three things at once: **accuracy** (WER, entity/keyterm correctness), **latency to the final transcript** (the only latency that moves voice-to-voice), and **reliability** (reconnect, keepalive, provider failover). The boundary of this domain is the transcript out.

## Narrative
Start with the streaming-vs-batch decision: conversational agents need a **persistent streaming socket**, not per-utterance batch HTTP [[STT-01-streaming-vs-batch]]. A streaming socket emits a **partial→final lifecycle** — growing interim hypotheses, optionally a stable "preflight" tier, then one authoritative final per utterance [[STT-02-partial-final-lifecycle]]. Because partials are noisy and revisable, the orchestrator gates them by **tiered confidence** — discard noise, keep mid-confidence, only let high-confidence partials interrupt the agent [[STT-03-confidence-filtering]].

Before any of that works, audio must reach the socket in the right shape: the socket declares an **encoding + sample_rate**, and transport PCM (8 kHz telephony / 48 kHz browser) must be **resampled** to it [[STT-04-input-format-resampling]]. Accuracy on domain words is then bought with **keyterm/keyword boosting** — model-specific params that silently no-op if mismatched [[STT-05-keyterm-boosting]] — which matters precisely because **STT errors are unrecoverable** and WER on *your* entities beats benchmark WER [[STT-06-wer-unrecoverable]].

Reliability is two layers: per-socket **reconnect + keepalive**, and cross-provider **fallback/failover** with background recovery probes [[STT-07-provider-fallback]]. Finally, two architectural choices shape the latency/quality trade: **segment-then-transcribe** (VAD-gated batch, e.g. Modal/Parakeet) can beat streaming on final-transcript time when you don't need partials [[STT-08-segment-then-transcribe]]; and **streaming-native encoders** (Nova/Flux/Parakeet, small look-ahead + cached activations) avoid Whisper's 30s-clip chunking hacks [[STT-09-streaming-native-vs-whisper]]. The stage ends by **delivering the final transcript** to the agent as a typed, finalized frame/event at the turn boundary [[STT-10-final-transcript-delivery]].

Before any signal reaches STT, the ingress path must be clean. **Audio preprocessing and denoising** [[STT-11-audio-preprocessing-denoising-ingress]] runs before VAD/STT — adaptive thresholding with percentile baselines (Vapi: 85th percentile, 3s RMS windows, −35dB fallback) filters background speech, and neural denoisers (Krisp/RNNoise) suppress ambient noise. A **pre-roll / look-back buffer** [[STT-12-preroll-lookback-buffer]] captures the ~500ms of audio before VAD triggers so word onsets aren't clipped. And when a batch STT model is the only option, the **StreamAdapter pattern** [[STT-13-stream-adapter-pattern]] wraps it behind VAD segmentation to emit partial/final transcripts on the same streaming interface — degraded but functional.

## Canonical implementations
- **Pipecat — classic streaming Deepgram:** `pipecat/src/pipecat/services/deepgram/stt.py` (socket lifecycle `:622`, send media `:534`, is_final branch `:685`, keepalive `:652`, reconnect+buffer replay `:463`, connect params/encoding `:540-597`).
- **Pipecat — Deepgram Flux (turn-event STT):** `pipecat/src/pipecat/services/deepgram/flux/base.py` (event enum `:97`, query/keyterm/eot params `:241`, avg-confidence final gate `:613-689`, eager EOT as interim `:696`).
- **Pipecat — base + segmented STT:** `pipecat/src/pipecat/services/stt_service.py` (`STTService` rate/run_stt `:282-384`; `SegmentedSTTService` VAD-gated WAV batch `:710-800`).
- **Pipecat — Whisper (batch chunking):** `pipecat/src/pipecat/services/whisper/stt.py:207`; **OpenAI resample:** `pipecat/src/pipecat/services/openai/stt.py:609`.
- **LiveKit Python — base + adapters:** `agents/livekit-agents/livekit/agents/stt/stt.py` (`SpeechEventType` incl. PREFLIGHT `:33`, `SpeechData.confidence` `:54`), `stream_adapter.py:97` (batch→stream via VAD), `fallback_adapter.py:175-243` (failover + recovery).
- **LiveKit — Soniox plugin (context boosting):** `agents/livekit-plugins/livekit-plugins-soniox/livekit/plugins/soniox/stt.py` (`ContextObject` `:74`, `STTOptions` rate/endpoint-delay `:116`).
- **Pipecat Krisp filter:** `audio/filters/krisp_viva_filter.py:35` (KrispVivaFilter, noise_suppression_level=100, 10ms frames).
- **Pipecat RNNoise filter:** `audio/filters/rnnoise_filter.py:30` (RNNoiseFilter, 48kHz required, QQ resample).
- **LiveKit Krisp plugin:** `livekit-plugins-krisp/.../viva_filter.py:62` (KrispVivaFilterFrameProcessor, plugs into AudioInputOptions).
- **Rapida denoisers:** `api/assistant-api/internal/denoiser/denoiser.go:27` (Krisp or RNNoise, switchable).
- **Pipecat pre-roll:** `services/google/gemini_live/llm.py:119,123,568,1417` (DEFAULT_USER_AUDIO_PREROLL_SECS=0.5, rolling buffer, replay on activity_start).
- **LiveKit StreamAdapter:** `stt/stream_adapter.py:97` (VAD → batch STT → SpeechEvent).
- **Rapida (Go) — Deepgram transformer:** `voice-ai/api/assistant-api/internal/transformer/deepgram/deepgram.go:50` (socket options, keyword-vs-keyterm model branch `:92-117`), `internal/stt_callback.go:52-143` (confidence discard gate `:60`, is_final emit `:81`, interim emit `:116`), `stt.go:75` (connect/keepalive/stream).

## Open questions / gaps
- **Preflight/eager-EOT in our stack:** do we want LiveKit's 3-tier (interim/preflight/final) or Flux's eager-EOT for speculative LLM prefill, or keep a clean binary final-only contract? (touches [[STT-02-partial-final-lifecycle]], [[STT-10-final-transcript-delivery]]).
- **Final-transcript latency benchmark:** Modal claims VAD-gated batch beats streaming on total v2v — unverified for our provider mix; need a per-provider final-transcript-time benchmark ([[STT-08-segment-then-transcribe]]).
- **Cross-provider fallback semantics:** LiveKit fails over but does a streaming socket fallback preserve mid-turn audio, or restart the turn? Not verified in code here ([[STT-07-provider-fallback]]).
- **Confidence on streaming-native turn models:** Flux averages per-word confidence at EndOfTurn; whether Nova-3 streaming exposes comparable per-partial confidence for the discard gate is unconfirmed ([[STT-03-confidence-filtering]]).
- **Resample ownership:** exactly one resample boundary (transport→16 kHz) is the goal; where telephony µ-law decode happens relative to the STT plugin needs an XPORT cross-check ([[STT-04-input-format-resampling]]).
