# OBS — Observability & Evaluation of the Speech Path (Map of Content)

## Core problem
A voice agent's quality is *experiential and probabilistic* — replies that start too early, pauses that stretch too long, responses that miss intent — and these failures are immediately audible. You cannot manage what you don't measure, but you also cannot measure each symptom independently. The discipline: emit one timestamped event at every turn boundary, correlate everything by session-id, and **derive** every latency/quality metric from that event log — then gate releases and run production on percentile SLOs over those derived metrics.

## The narrative
1. **Instrument once, derive everything.** The only raw signal is a timestamped event at every user/agent turn boundary (UserStarted/Stopped, AgentThinking/Started/AudioDone, FunctionCall*) — see [[OBS-01-event-instrumentation-turn-boundaries]]. LiveKit fans these in as a typed `metrics_collected` event bus; Pipecat reconstructs them with passive frame observers.
2. **The headline metric** falls straight out: UserStoppedSpeaking → AgentStartedSpeaking, computed as a literal timestamp subtraction ([[OBS-02-canonical-timing-metric]]). Anchor "user stopped" to *raw VAD silence minus hangover* so endpointing cost stays *inside* the number.
3. **Roll it into a quality index.** Deepgram's VAQI = Interruptions / Missed-responses / Latency, all timestamp-derived ([[OBS-03-vaqi-i-m-l]]); compute I from interruptions *minus backchannels* (LiveKit's split).
4. **Decompose the latency.** Per-stage metrics localize the slow stage: LLM `ttft`, TTS `ttfb`, STT `audio_duration` — LiveKit's typed dataclasses and Pipecat's TTFB frames ([[OBS-04-per-stage-latency-metrics]]).
5. **Split the "user stopped" wait** into transcription_delay vs end_of_utterance_delay — LiveKit's `EOUMetrics` is the only clone that separates STT lag from endpointing policy ([[OBS-05-eou-vs-transcription-delay]]).
6. **Express SLOs on the tail.** P95/P99 per (region, provider-deployment), as histograms not averages — worst-case turns break conversation ([[OBS-06-slos-percentiles-tail]]).
7. **Correlate by session-id** across transcripts/events/metrics/errors/traces, with finer speech-id / request-id for sub-turn causality ([[OBS-07-session-id-correlation]]).
8. **Export as OTel traces** (conversation→turn→stage spans) *and* Prometheus histograms — traces for drill-down, histograms for SLOs ([[OBS-08-otel-traces-spans]]).
9. **Test the distribution, not a single output:** replay (constant input), load on tail, fault injection, turn-level diagnostics ([[OBS-09-replay-load-fault-injection]]).
10. **Run two production feeds** — synthetic probes + real-user telemetry — and shadow-transcribe S2S models for auditability ([[OBS-10-synthetic-real-user-monitoring]]).

## Canonical implementations
- **LiveKit Python (`_clones/agents`)** — the gold reference for typed per-stage metrics:
  - `livekit-agents/livekit/agents/metrics/base.py` — `LLMMetrics.ttft` (:20), `STTMetrics` (:37), `TTSMetrics.ttfb` (:59), `VADMetrics` (:84), `EOUMetrics{end_of_utterance_delay, transcription_delay, on_user_turn_completed_delay}` (:94), `RealtimeModelMetrics.ttft`=first-audio-token (:115), `InterruptionMetrics{num_interruptions, num_backchannels, detection_delay}` (:166).
  - `voice/agent_activity.py:2769` — `e2e_latency = started_speaking_at − stopped_speaking_at` (the canonical metric); `:1492` re-emits `MetricsCollectedEvent` on the session bus; `:679–739` wires `metrics_collected` off every component.
  - `voice/audio_recognition.py:1194` — `transcription_delay`/`end_of_turn_delay` computation; `:1185` refuse-to-compute on unreliable VAD.
  - `telemetry/otel_metrics.py:23–47` — per-turn OTel histograms (e2e_latency, llm_ttft, tts_ttfb, transcription_delay, end_of_turn_delay); `telemetry/trace_types.py:54–69` — `lk.*` span attributes; `telemetry/http_server.py` — Prometheus endpoint.
  - `metrics/usage_collector.py`, `metrics/usage.py` — session-level usage aggregation.
- **LiveKit JS (`_clones/agents-js`)** — `agents/src/metrics/base.ts`: `ttftMs` (:30), `ttfbMs` (:73), `EOUMetrics{endOfUtteranceDelayMs, transcriptionDelayMs, lastSpeakingTimeMs}` (:101); `telemetry/` mirrors the Python span attributes.
- **Pipecat (`_clones/pipecat`)** — observer/frame model:
  - `metrics/metrics.py:29` `TTFBMetricsData`, `:39` `ProcessingMetricsData`, `:101` `TurnMetricsData`.
  - `processors/frame_processor.py:425,437` — `start_ttfb_metrics`/`stop_ttfb_metrics` bracket pushing `MetricsFrame`; service mechanism in `services/tts_service.py:1082,1488` and `services/stt_service.py:565,584` (STT TTFB ≡ transcription delay).
  - `observers/user_bot_latency_observer.py:292` — UserStopped→BotStarted latency + `LatencyBreakdown`; `observers/turn_tracking_observer.py` — turn bracketing.
  - `utils/tracing/turn_trace_observer.py:36` — conversation→turn→service span tree; `utils/tracing/service_attributes.py:93` — GenAI OTel semantic conventions.
- **Deepgram ebook (`_sources`)** — VAQI I/M/L (line 962–971), telephony scorecard (775–779), observability pipeline + SLOs (1018–1081), event vocabulary (1035, 1998–2006), testing methods (979–997).
- **Coval / Pyannote** — external eval (Deepgram pairs with Coval for probabilistic/semantic; Modal uses Pyannote Precision-2 diarization to recover turn boundaries for offline v2v eCDFs, modal-v2v line 46).

## Open questions / gaps
- **No clone ships a rolled-up VAQI index** — both emit raw constituents (InterruptionMetrics, e2e_latency); Syrinx must define the I/M/L aggregation + tolerance bands itself.
- **"Missed-response (M) window"** is undefined numerically in every source — must be set per deployment.
- **Replay/load/fault-injection harnesses are not in the OSS clones** — telemetry exists, test rigs don't (Deepgram outsources to Coval). Build needed.
- **S2S shadow-transcription** for auditability is a recommended tactic (together-talk) with no clone reference implementation.
- **Where to compute e2e** — at the orchestrator (LiveKit, has all timestamps) vs. client-side via diarization (Modal, captures true hardware-to-hardware latency incl. playback). The client-side number is larger and truer; pick deliberately.

Neighbors: [[wiki/turn-map]] [[wiki/lat-map]] [[wiki/rel-map]] [[wiki/barge-map]] [[wiki/stt-map]] [[wiki/tts-map]]
