# Production-Ready Checklist for the Syrinx Voice Engine

Scope: speech-in / speech-out only. The engine boundary is audio transport -> STT/VAD/turn-taking -> final transcript out, and response text in -> TTS/audio transport out. Agent reasoning, prompting, tool policy, and RAG are out of scope except where cancellation or latency metrics cross the boundary.

Evidence discipline: each requirement cites a verified atomic note and a canonical OSS implementation line. When a number comes only from a source or MOC, it is marked as source-only or unverified in clone code.

## Tier Split

**Tier-0 / must ship**

- Audio can run over WebRTC for clients and WebSocket for provider/telephony hops, with int16 mono PCM internally, explicit sample-rate/encoding handshakes, stateful edge resampling, 10-50 ms frame discipline, telephony µ-law serialization, keepalive, and bounded jitter buffering.
- STT is persistent streaming by default, emits typed interim/final transcript events, filters low-confidence output, resamples to the declared provider rate, supports keyterm boosting, and fails over to at least one degraded provider path.
- Turn-taking has one owner per boundary: VAD hysteresis plus one endpointing strategy, or provider-owned EOT with downstream VAD disabled.
- Barge-in is full-duplex and executes media stop + logic cancel + buffer flush + listen re-entry as one priority event; history records only the spoken prefix.
- TTS streams, measures TTFA/TTFB, aggregates response text into sentence/clause units, outputs transport-native audio, and is cancellable on interruption.
- Reliability has reconnect/backoff, quick-failure detection, application keepalive, stall watchdogs, provider availability tracking, graceful degradation, and drain-on-shutdown.
- Observability emits monotonic turn-boundary events and per-stage metrics, including the canonical UserStoppedSpeaking -> AgentStartedSpeaking latency.

**Tier-1 / hardening**

- Eager EOT / preemptive generation with commit-time validation and scrap-on-resume.
- Dynamic hedging and bandit routing for provider tail latency.
- Backchannel-vs-interruption classification and false-interruption resume.
- VAD provider benchmarking and optional supervised VAD subprocess isolation.
- VAQI rollup, replay/load/fault-injection harnesses, synthetic probes, and real-user monitoring.
- Multilingual metadata propagation, dynamic TTS voice switching, and persona-consistent localization.
- µ-law passthrough where STT/TTS providers support it natively, plus verified Opus FEC configuration for the chosen WebRTC stack.

## 1. Audio Transport

- [ ] **Support WebRTC for browser/mobile clients and WebSocket for provider and telephony hops** — the lossy client link needs WebRTC media behavior, while provider and carrier backbones use persistent ordered sockets.
      Evidence: XPORT-01, ARCH-10. Canonical: `_clones/pipecat/src/pipecat/transports/smallwebrtc/transport.py:76`, `_clones/pipecat/src/pipecat/transports/websocket/server.py:418`, `_clones/pipecat/src/pipecat/serializers/twilio.py:238`.
      Target/number: client link WebRTC; STT/TTS and Twilio/Telnyx style carrier links WebSocket.

- [ ] **Use int16 mono PCM internally and isolate 8 kHz µ-law to telephony edges** — sample-rate drift and encoding mismatch are production failure modes, not cleanup details.
      Evidence: XPORT-02, XPORT-04, REL-12. Canonical: `_clones/pipecat/src/pipecat/frames/frames.py:855` (16 kHz in / 24 kHz out defaults), `_clones/pipecat/src/pipecat/serializers/twilio.py:255`.
      Target/number: 16 kHz STT ingress default, 24 kHz TTS egress default, 48 kHz WebRTC/Opus edge, 8 kHz µ-law/A-law telephony edge.

- [ ] **Declare and assert actual encoding/sample_rate on every STT/TTS socket handshake** — sending PCM while declaring µ-law, or 48 kHz while declaring 16 kHz, produces choppy or distorted audio.
      Evidence: STT-04, REL-12. Canonical: `_clones/pipecat/src/pipecat/services/deepgram/stt.py:568-573`.
      Target/number: `declared_encoding == actual_encoding` and `declared_sample_rate == actual_sample_rate` at connect-time.

      ```pseudo
      def connect_stream(provider, audio_format):
          assert audio_format.bytes_are(audio_format.declared_encoding)
          assert audio_format.rate_hz == audio_format.declared_rate_hz
          kwargs = provider.base_options()
          kwargs["encoding"] = audio_format.declared_encoding
          kwargs["sample_rate"] = str(audio_format.declared_rate_hz)
          return provider.open_stream(**kwargs)
      ```

- [ ] **Resample only at transport/provider edges with a stateful streaming resampler** — fresh per-chunk resamplers click at boundaries and cascading resamplers degrade speech.
      Evidence: XPORT-03, REL-12. Canonical: `_clones/pipecat/src/pipecat/audio/resamplers/soxr_stream_resampler.py:30-37`, `_clones/pipecat/src/pipecat/serializers/twilio.py:255-258`.
      Target/number: keep resampler state across chunks; clear stream state after about 0.2 s inactivity where using Pipecat-style soxr.

- [ ] **Frame outbound audio in small fixed chunks and re-chunk long TTS frames before playout** — barge-in cannot cut promptly if the output queue holds sentence-sized frames.
      Evidence: XPORT-05, TTS-07. Canonical: `_clones/pipecat/src/pipecat/transports/base_transport.py:69`, `_clones/pipecat/src/pipecat/transports/base_output.py:82-85`, `_clones/pipecat/src/pipecat/transports/base_output.py:131-135`.
      Target/number: 10-50 ms frame range; default Syrinx target 20 ms egress chunks, with 10 ms quantum supported.

- [ ] **Hold a bounded playout jitter buffer and pace sends in real time** — network jitter should not become stutter, but excess buffering damages interruption latency.
      Evidence: XPORT-06, TTS-07. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/room_io/_output.py:45` (200 ms playout queue, `queue_size_ms=200`). (NB: `telnyx/.../audio_processor.go:118` `bufferAndSendInput` is a 60 ms *ingress* batch, `InputBufferThreshold=32*60`:31 — not a playout jitter buffer; no clone implements a 100 ms playout buffer.)
      Target/number: ~100 ms playout jitter buffer is **source-only** (deepgram-ebook:518); LiveKit's 200 ms `queue_size_ms` is the only clone playout buffer — treat 100-200 ms as the design band.

- [ ] **Implement provider-specific telephony serializers with stream identity, µ-law conversion, DTMF routing, and clear-on-interrupt** — carrier JSON envelopes are correctness contracts.
      Evidence: XPORT-04, XPORT-07, XPORT-11, BARGE-04. Canonical: `_clones/pipecat/src/pipecat/serializers/twilio.py:149-151`, `_clones/pipecat/src/pipecat/serializers/twilio.py:251-258`.
      Target/number: every outbound Twilio media/control message includes the carrier stream id; interruption emits `clear` before next response audio.

      ```pseudo
      def serialize_twilio(frame, stream_sid):
          if frame.type == "interrupt":
              return {"event": "clear", "streamSid": stream_sid}
          if frame.type == "audio":
              ulaw = pcm_to_ulaw(frame.pcm, frame.rate_hz, 8000)
              return {"event": "media", "streamSid": stream_sid,
                      "media": {"payload": base64(ulaw)}}
          if frame.type == "dtmf":
              route_dtmf_outside_stt(frame.digit)
      ```

- [ ] **Emit output silence and provider keepalives when idle** — long-lived media sockets are reaped or underrun when they go quiet.
      Evidence: XPORT-08, REL-03. Canonical: `_clones/pipecat/src/pipecat/transports/base_transport.py:72-73`, `_clones/pipecat/src/pipecat/transports/smallwebrtc/transport.py:140`, `_clones/pipecat/src/pipecat/services/deepgram/stt.py:652-663`.
      Target/number: Deepgram idle timeout 10 s; send application keepalive every 5 s / provider-recommended 3-5 s; emit 2 s output silence tail after end frame where applicable.

- [ ] **Configure WebRTC Opus deliberately, including FEC where the stack exposes it** — packet loss concealment happens below the PCM pipeline and must be verified at media negotiation time.
      Evidence: XPORT-09, XPORT-12. Canonical: `_clones/voice-ai/api/assistant-api/internal/channel/webrtc/internal/types.go:11-16`, `_clones/voice-ai/api/assistant-api/internal/channel/webrtc/streamer.go:168-178`.
      Target/number: Opus 48 kHz, 20 ms frames, `useinbandfec=1` where configurable. Browser/aiortc FEC defaults are outside this clone set (unverified).

- [ ] **Keep DTMF outside speech recognition and route it as a typed control event** — keypad input must not pollute transcripts or trigger barge-in logic.
      Evidence: XPORT-11. Canonical: `_clones/pipecat/src/pipecat/serializers/twilio.py:238-258`, `_clones/agents/examples/telephony/basic_dtmf_agent.py`.
      Target/number: support digits `0-9`, `*`, `#`; never feed DTMF tones as STT audio.

## 2. STT Ingestion

- [ ] **Use a persistent streaming STT socket as the default conversational path** — batch HTTP per utterance throws away partials and pays setup latency per turn.
      Evidence: STT-01, STT-09. Canonical: `_clones/pipecat/src/pipecat/services/deepgram/stt.py:622-643`, `_clones/pipecat/src/pipecat/services/deepgram/stt.py:523-538`.
      Target/number: one long-lived stream per active conversation/provider leg, reused across turns until provider/session recycle.

- [ ] **Model transcripts as typed interim/preflight/final events and hand only finals to the agent contract** — interim text is useful for UI, barge-in, and speculation, but the agent turn must commit exactly once.
      Evidence: STT-02, STT-10. Canonical: `_clones/pipecat/src/pipecat/services/deepgram/stt.py:685-705`, `_clones/voice-ai/api/assistant-api/internal/transformer/deepgram/internal/stt_callback.go:81-127`.
      Target/number: one authoritative final transcript per user utterance; interim events may revise.

- [ ] **Filter low-confidence STT output before it can mutate state or interrupt speech** — STT errors are unrecoverable once passed to the agent.
      Evidence: STT-03, STT-06, BARGE-06. Canonical: `_clones/voice-ai/api/assistant-api/internal/transformer/deepgram/internal/stt_callback.go:60-78`.
      Target/number: provider-configured confidence threshold; low-confidence transcript emits a telemetry/event packet and is not processed as a user utterance.

      ```pseudo
      def on_stt_result(result):
          if result.confidence < stt_threshold:
              emit("stt.low_confidence", text=result.text,
                   confidence=result.confidence, threshold=stt_threshold)
              return
          emit_transcript(text=result.text,
                          interim=not result.is_final,
                          confidence=result.confidence,
                          language=result.language)
      ```

- [ ] **Resample ingress audio to the STT provider's declared rate before sending bytes** — STT receives the audio shape it was promised, not the transport-native shape.
      Evidence: STT-04, XPORT-03. Canonical: `_clones/pipecat/src/pipecat/services/deepgram/stt.py:568-573`, `_clones/agents/livekit-agents/livekit/agents/voice/room_io/_input.py:368`.
      Target/number: 16 kHz linear16 default for STT; 8 kHz µ-law only when the STT provider is explicitly configured to accept it natively.

- [ ] **Provide model-specific keyword/keyterm boosting for domain entities** — benchmark WER is less important than correct names, products, account ids, and workflow terms.
      Evidence: STT-05, STT-06. Canonical: `_clones/pipecat/src/pipecat/services/deepgram/stt.py:552-560`, `_clones/voice-ai/api/assistant-api/internal/transformer/deepgram/deepgram.go:92-117`.
      Target/number: validate provider/model param names in tests; e.g. Rapida maps Nova-2 to `Keywords` and Nova-3 to `Keyterm`.

- [ ] **Keep a 500 ms pre-roll buffer before VAD start and replay it into STT on speech start** — VAD confirmation lag otherwise clips first syllables.
      Evidence: STT-12, TURN-01. Canonical: `_clones/pipecat/src/pipecat/services/google/gemini_live/llm.py:123`, `_clones/pipecat/src/pipecat/services/google/gemini_live/llm.py:1417-1420`.
      Target/number: 500 ms default look-back, or `vad_start_secs + 100 ms` autosized margin when the upstream VAD exposes it.

- [ ] **Wrap non-streaming STT behind a VAD-based StreamAdapter for degraded fallback** — provider-agnostic fallback should not change the orchestrator interface.
      Evidence: STT-08, STT-13, REL-08. Canonical: `_clones/agents/livekit-agents/livekit/agents/stt/stream_adapter.py:18-28`, `_clones/agents/livekit-agents/livekit/agents/stt/stream_adapter.py:97-125`.
      Target/number: adapter emits start/end-of-speech and final transcripts only; no interim results on batch-STT fallback.

- [ ] **Front STT providers with a stateful fallback adapter and background recovery probes** — a flapping provider should be skipped on hot turns until it proves recovery.
      Evidence: STT-07, REL-08. Canonical: `_clones/agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:23-24` (conn_options `max_retry=0`), `...stt/fallback_adapter.py:54` (`max_retry_per_stt=1`, `attempt_timeout=10.0` at :53), `...stt/fallback_adapter.py:175-248` (background recovery probes).
      Target/number: per-call `max_retry=0` on the hot path; per-provider `max_retry_per_stt=1`; `attempt_timeout` default 10 s in LiveKit but Syrinx should set a voice-specific lower value after measuring provider tails.

## 3. Turn-Taking & Endpointing

- [ ] **Implement VAD as a hysteretic state machine, not a single energy cutoff** — noisy rooms and phone lines flap without asymmetric state.
      Evidence: TURN-01. Canonical: `_clones/pipecat/src/pipecat/audio/vad/vad_analyzer.py:24-27`, `_clones/pipecat/src/pipecat/audio/vad/vad_analyzer.py:206-243`.
      Target/number: states QUIET -> STARTING -> SPEAKING -> STOPPING; Pipecat defaults confidence 0.7, start 0.2 s, stop 0.2 s, min_volume 0.6.

- [ ] **Treat endpointing delay, STT final latency, and VAD stop time as one budget** — tuning them independently creates either premature replies or dead air.
      Evidence: TURN-08, OBS-05. Canonical: `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:94-105`, `_clones/pipecat/src/pipecat/turns/user_stop/speech_timeout_user_turn_stop_strategy.py:48`.
      Target/number: derive `VAD stop_secs + endpointing_delay + STT_final_latency`; keep the sum inside the v2v budget, not just each knob locally small.

- [ ] **Use a semantic/contextual EOT strategy where available, with rule/timer fallback** — silence is not the same as end-of-turn.
      Evidence: TURN-03, TURN-04, TURN-05, TURN-06, TURN-07. Canonical: `_clones/pipecat/src/pipecat/turns/user_turn_strategies.py:27-51`, `_clones/agents/livekit-agents/livekit/agents/voice/audio_recognition.py:1106`.
      Target/number: support provider EOT, audio-only EOT, text-only EOU, regex/rule strategies, and external strategy injection.

- [ ] **Disable redundant downstream VAD/endpointing when the STT provider owns turn boundaries** — multiple turn owners desynchronize and cause double-finalization or premature replies.
      Evidence: TURN-04, TURN-10. Canonical: `_clones/pipecat/src/pipecat/services/cartesia/turns/stt.py:60-63`, `_sources/pdf/deepgram-voice-agent.parsed.md` (source-only).
      Target/number: exactly one source of truth for each boundary event; document owner per session mode.

- [ ] **Support eager EOT as a speculative signal, but commit only on final EOT** — the latency win is overlapping LLM TTFT with the final silence wait.
      Evidence: TURN-09, LAT-09, LAT-10. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/agent_activity.py:1872-1919`, `_clones/agents/livekit-agents/livekit/agents/voice/agent_activity.py:2086-2111`.
      Target/number: speculative output must be scheduled with no audio playout until final validation.

      ```pseudo
      on_eager_eot(transcript):
          pre = start_llm(transcript, schedule_speech=False)
          cache_preemptive(pre, transcript, ctx_hash(), tools_hash())

      on_final_eot(final_transcript):
          if pre and pre.key == (final_transcript, ctx_hash(), tools_hash()):
              schedule_speech(pre.handle)
          else:
              cancel(pre)
              schedule_speech(start_llm(final_transcript))
      ```

- [ ] **Classify backchannels separately from true interruptions** — "mm-hmm" should not derail the agent's turn.
      Evidence: TURN-11, BARGE-06. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/turn.py:108-125`, `_clones/agents-js/agents/src/inference/interruption/defaults.ts:7-10`.
      Target/number: LiveKit defaults `min_duration=0.5 s`, false-interruption timeout 2.0 s, backchannel boundary `(1.0, 1.0)`; JS classifier threshold 0.5 with 2 x 25 ms minimum frames.

- [ ] **Benchmark multiple VAD providers before locking the default** — VAD cost, language robustness, cold-start, and endpointing delay differ by deployment.
      Evidence: TURN-12. Canonical: `_clones/voice-ai/api/assistant-api/internal/vad/vad.go:27`, `_clones/voice-ai/api/assistant-api/internal/vad/BENCHMARK_COMPARISON.md`.
      Target/number: run the benchmark on Syrinx target hardware; Rapida's M1 Pro benchmark numbers are not portable.

## 4. Barge-In / Interruption

- [ ] **Keep input and output audio loops full-duplex during agent speech** — an agent cannot be interrupted if microphone input stops while it speaks.
      Evidence: BARGE-01, XPORT-10. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/audio_recognition.py:152`, `_clones/pipecat/src/pipecat/turns/user_mute/always_user_mute_strategy.py:14`.
      Target/number: mic remains open in barge-in mode; hard mute is allowed only for explicit half-duplex/push-to-talk modes.

- [ ] **Route interruption signals on a high-priority control lane ahead of audio/text data** — a TTS backlog must not delay cancellation.
      Evidence: ARCH-03, BARGE-02. Canonical: `_clones/pipecat/src/pipecat/processors/frame_processor.py:119-154`, `_clones/pipecat/src/pipecat/processors/frame_processor.py:996-1042`.
      Target/number: system/control frames overtake data frames; Vapi's <100 ms interruption sequence is source-only and unmeasured in OSS clones.

- [ ] **On real interruption, cancel logic and media together: abort speculative/active LLM, stop TTS, flush output, return to listening** — stopping sound without stopping generation leaves stale state.
      Evidence: BARGE-02, BARGE-03, LAT-10. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/agent_activity.py:1249-1284`, `_clones/pipecat/src/pipecat/processors/frame_processor.py:632-637`.
      Target/number: instrument onset -> media-silent and onset -> logic-cancel; target <100 ms is Vapi source-only and must be verified in Syrinx.

      ```pseudo
      on_user_started_speaking(signal):
          if not interruption_gate(signal):
              return
          publish_high_priority("Interruption")
          cancel_preemptive_generation()
          interrupt_current_speech()
          tts.cancel_context()
          output.flush_interruptible()
          state = "listening"
      ```

- [ ] **Flush only interruptible audio/text frames and preserve required control frames** — interruption should drop queued speech, not lose terminal/tool/control events.
      Evidence: BARGE-04, ARCH-03. Canonical: `_clones/pipecat/src/pipecat/transports/base_output.py:538-555`, `_clones/pipecat/src/pipecat/services/tts_service.py:902-918`.
      Target/number: queue primitive supports selective reset; emit a playback-reset confirmation before accepting next response audio.

- [ ] **Gate interruption by duration, confidence, and backchannel classification** — raw VAD spikes, coughs, and short acknowledgments are not user intent.
      Evidence: BARGE-06, TURN-11, STT-03. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/turn.py:117-125`, `_clones/voice-ai/api/assistant-api/internal/transformer/deepgram/internal/stt_callback.go:60-78`.
      Target/number: minimum sustained speech about 0.5 s where using LiveKit-style defaults; STT confidence threshold is provider/deployment configured.

- [ ] **Record assistant history as the spoken prefix, not the generated response** — after barge-in, the LLM must not believe the user heard words that never played.
      Evidence: BARGE-05, BARGE-08, TTS-11. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/transcription/synchronizer.py:294-299`, `_clones/agents/livekit-agents/livekit/agents/voice/agent_activity.py:2415-2448`, `_clones/pipecat/src/pipecat/transports/base_output.py:379-380`.
      Target/number: use TTS word timestamps when reliable; fallback to playback-clock x speaking-rate estimate.

      ```pseudo
      on_speech_finished(interrupted):
          if not interrupted:
              assistant_text = full_generated_text
          elif tts.has_word_timestamps:
              assistant_text = words_played_before(cut_time)
          else:
              assistant_text = estimate_prefix(playback_elapsed, speaking_rate)
          chat.add(role="assistant", content=assistant_text, interrupted=interrupted)
      ```

- [ ] **Implement false-interruption pause/resume where the audio output can pause** — aggressive barge-in should recover when no real utterance follows.
      Evidence: BARGE-09. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/turn.py:117-125`, `_clones/agents/livekit-agents/livekit/agents/voice/agent_activity.py:3669`.
      Target/number: LiveKit default false-interruption timeout 2.0 s; fallback to destructive flush if output cannot pause.

## 5. TTS Egress

- [ ] **Use streaming TTS, not whole-utterance synthesis, for interactive responses** — perceived speech-out latency is time-to-first-audio, not full synthesis duration.
      Evidence: TTS-01, TTS-02. Canonical: `_clones/pipecat/src/pipecat/services/cartesia/tts.py:722`, `_clones/agents/livekit-agents/livekit/agents/tts/tts.py:234`.
      Target/number: TTFA/TTFB measured request start -> first audio frame.

- [ ] **Aggregate LLM tokens into sentence or clause units before TTS** — token-by-token speech is fast but prosodically broken; whole-response batching is too slow.
      Evidence: TTS-03. Canonical: `_clones/pipecat/src/pipecat/utils/text/simple_text_aggregator.py:78-125`, `_clones/voice-ai/api/assistant-api/internal/normalizer/output/aggregator/text_aggregator.go:45-52`, `_clones/voice-ai/api/assistant-api/internal/normalizer/output/aggregator/text_aggregator.go:114-130`.
      Target/number: preserve leading whitespace across boundaries; use a minimum chunk floor around LiveKit's 20-character default where short fragments sound choppy.

- [ ] **Send the first complete sentence immediately, then optionally pace later batches against remaining audio** — this protects TTFA while reducing wasted synthesis after barge-in.
      Evidence: TTS-05. Canonical: `_clones/agents/livekit-agents/livekit/agents/tts/stream_pacer.py:20-35` (defaults), `_clones/agents/livekit-agents/livekit/agents/tts/stream_pacer.py:97-164` (send loop; 0.1 s drain check at :123, 0.2 s in-progress poll at :159).
      Target/number: LiveKit pacer default `min_remaining_audio=5.0 s`, `max_text_length=300`, generation poll 0.2 s.

- [ ] **Select TTS models with RTF < 1 under target concurrency and alert when synthesis falls behind playback** — streaming does not help if the buffer drains.
      Evidence: TTS-04. Canonical: `_clones/agents/livekit-agents/livekit/agents/tts/stream_pacer.py:117-135`.
      Target/number: real-time factor below 1.0 at P95/P99 load; no OSS clone directly measures RTF, so Syrinx must add the gauge.

- [ ] **Output transport-native audio and avoid avoidable telephony transcoding** — native µ-law output is a latency and fidelity win when the provider supports it.
      Evidence: TTS-06, XPORT-04. Canonical: `_clones/pipecat/src/pipecat/serializers/twilio.py:149-153`, `_clones/voice-ai/api/assistant-api/internal/channel/telephony/internal/telnyx/internal/audio_processor.go:130`.
      Target/number: telephony output 8 kHz µ-law; browser/WebRTC output PCM/Opus edge at 48 kHz; passthrough µ-law is a Tier-1 benchmark because Pipecat is PCM-internal.

- [ ] **Make TTS contexts interruptible and cancellation-safe** — barge-in must tear down provider synthesis as well as local buffers.
      Evidence: TTS-08, BARGE-04. Canonical: `_clones/pipecat/src/pipecat/services/tts_service.py:902-918`, `_clones/pipecat/src/pipecat/services/cartesia/tts.py:676-688`.
      Target/number: cancellation completes before next response context starts; cancelled TTS metrics are excluded from latency distributions.

- [ ] **Capture word or character timestamps from TTS and convert them into playback-timed text frames** — spoken-prefix reconstruction and UI captions depend on alignment.
      Evidence: TTS-11, BARGE-05. Canonical: `_clones/pipecat/src/pipecat/services/tts_service.py:1185-1264`, `_clones/pipecat/src/pipecat/services/cartesia/tts.py:676-688`.
      Target/number: prefer provider word timestamps; support char-alignment reassembly where provider emits characters.

- [ ] **Support provider-specific pronunciation controls for domain words and names** — TTS mispronunciation is a production-quality failure on branded or regulated terms.
      Evidence: TTS-10, LANG-04. Canonical: `_clones/pipecat/src/pipecat/services/cartesia/tts.py:192-204`, `_clones/pipecat/src/pipecat/services/aws/tts.py:345`, `_clones/pipecat/src/pipecat/services/rime/tts.py:379`.
      Target/number: per-assistant pronunciation dictionary or text transformer; test alignment behavior when pronunciation dictionaries change timestamp fields.

## 6. Latency Engineering

- [ ] **Make voice-to-voice latency the headline metric and optimize P95/P99, not the mean** — a single 5 s tail turn breaks the conversation even if the average is good.
      Evidence: LAT-01, LAT-03, LAT-12, OBS-06. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/agent_activity.py:2768-2771`, `_clones/agents/livekit-agents/livekit/agents/telemetry/otel_metrics.py:23-47`.
      Target/number: natural about 300 ms, noticeable >500 ms, flow-break about 1200 ms, hang-up risk 1-2 s; production SLOs on P95/P99.

- [ ] **Emit first-token/first-byte metrics for every provider stage with monotonic timing and cancellation flags** — latency work needs a stage budget, not anecdotes.
      Evidence: LAT-02, OBS-04. Canonical: `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:20-81` (LLMMetrics.ttft, TTSMetrics.ttfb), `_clones/pipecat/src/pipecat/services/tts_service.py:1082` (calls `start_ttfb_metrics`), `_clones/pipecat/src/pipecat/processors/metrics/frame_processor_metrics.py:88` (`start_ttfb_metrics` impl).
      Target/number: LLM `ttft`, TTS `ttfb`, STT `audio_duration`/`acquire_time`, EOU `transcription_delay` and `end_of_utterance_delay`; exclude cancelled attempts.

- [ ] **Budget the turn across STT, endpointing, LLM, TTS, and network explicitly** — the LLM is usually dominant, but every 10 ms matters after the basics are fixed.
      Evidence: LAT-04, LAT-08. Canonical: `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:37-81`, `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:94-105`.
      Target/number: source split ASR about 300 ms, LLM 200-900 ms, TTS about 400 ms; co-location can cut a 75 ms network hop to about 5 ms (source-only).

- [ ] **Co-locate orchestrator, STT, LLM, and TTS provider endpoints where possible** — network transit is an independent budget line.
      Evidence: LAT-08. Canonical: `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:52-55` (connection acquire/reuse visibility).
      Target/number: source-only target 75 ms cross-region hop -> 5 ms co-located hop; measure by region/provider deployment.

- [ ] **Use preemptive generation only with predict-and-scrap validation** — speculation is useful only if wrong guesses never reach the user.
      Evidence: LAT-09, LAT-10, TURN-09. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/agent_activity.py:1872-1919`, `_clones/agents/livekit-agents/livekit/agents/voice/agent_activity.py:2086-2111`.
      Target/number: LiveKit default options include `max_speech_duration=10.0 s`, `max_retries=3`; `preemptive_tts` is default-off in the notes and should stay gated until measured.

- [ ] **Hedge silent provider hangs with dynamic per-endpoint timeouts after telemetry exists** — waiting for an exception is not a strategy when the request just hangs.
      Evidence: LAT-06, REL-05. Canonical: `_clones/agents/livekit-agents/livekit/agents/llm/fallback_adapter.py:45` (static analog only).
      Target/number: Vapi mean + k*sigma timeout is source-only; no OSS clone implements dynamic hedging, so ship as Tier-1 after per-endpoint histograms are populated.

- [ ] **Route traffic by measured provider latency and tail health, not static preference alone** — deployments swing independently and the fastest provider changes.
      Evidence: LAT-07, OBS-06. Canonical: no OSS implementation; LiveKit fallback availability is the closest reliability primitive at `_clones/agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:95-103`.
      Target/number: bandit exploit/explore routing is source-only; define exploration slice and cost guard before enabling.

- [ ] **Budget pre-TTS guardrail classifier latency as a critical-path stage** — once audio is spoken it cannot be unsaid, but the safety gate still spends TTFA.
      Evidence: ARCH-11, LAT-13. Canonical: no verified clone path for pre-TTS guardrail placement.
      Target/number: add P95 classifier latency to the per-sentence TTS budget; clone implementation unverified.

## 7. Reliability

- [ ] **Reconnect provider and control WebSockets with bounded backoff and post-connect verification** — transient drops are normal for long-lived streams.
      Evidence: REL-01. Canonical: `_clones/pipecat/src/pipecat/services/websocket_service.py:83`, `_clones/pipecat/src/pipecat/utils/network.py:10`, `_clones/agents/livekit-agents/livekit/agents/worker.py:1096-1103`.
      Target/number: floor around 4 s and cap around 10 s for Pipecat-style provider retry; LiveKit control-plane retries linearly by `n*2` capped at 10 s.

- [ ] **Detect rapid post-handshake failures and stop retry storms** — bad credentials or policy rejects can connect then immediately close forever.
      Evidence: REL-02. Canonical: `_clones/pipecat/src/pipecat/services/websocket_service.py:31`, `_clones/pipecat/src/pipecat/services/websocket_service.py:166-189`.
      Target/number: 3 consecutive connections lasting <5 s -> fatal configuration error, not infinite reconnect.

- [ ] **Re-inject provider config and replay the failed in-flight frame after reconnect** — recovery should be a hiccup, not amnesia.
      Evidence: REL-04. Canonical: `_clones/pipecat/src/pipecat/services/websocket_service.py:122-138`, `_clones/agents/livekit-agents/livekit/agents/stt/stt.py:390-398`.
      Target/number: new socket receives full model/language/encoding/keyterm config; transcript timestamps remain monotonic across reconnect.

- [ ] **Run active cadence watchdogs for pipeline heartbeat and input audio gaps** — silent stalls do not throw clean exceptions.
      Evidence: REL-05. Canonical: `_clones/pipecat/src/pipecat/pipeline/worker.py:87-88`, `_clones/pipecat/src/pipecat/pipeline/worker.py:1161-1188`, `_clones/pipecat/src/pipecat/transports/base_input.py:31`.
      Target/number: heartbeat every 1.0 s, alarm around 10.0 s; input audio watchdog 0.5 s. Pipecat's input timeout currently comments but does not recover, so Syrinx must implement recovery.

- [ ] **Define graceful degradation per speech layer and never fail silently** — callers tolerate recovery prompts better than unexplained silence.
      Evidence: REL-06, REL-10. Canonical: `_clones/pipecat/src/pipecat/processors/frame_processor.py:644-678`, `_clones/agents/livekit-agents/livekit/agents/tts/fallback_adapter.py:46`.
      Target/number: STT low-confidence -> clarification; TTS fail -> fallback voice or canned clip; reasoning/tool fail -> verbal acknowledgement/escalation outside engine scope.

- [ ] **Drain on scale-down, deploy, and SIGTERM before killing a live call** — stateful long-running calls cannot be treated like stateless HTTP requests.
      Evidence: REL-07. Canonical: `_clones/agents/livekit-agents/livekit/agents/worker.py:203`, `_clones/agents/livekit-agents/livekit/agents/worker.py:872-900`.
      Target/number: stop accepting new sessions, wait for active conversations; LiveKit default drain timeout 1800 s / 30 min.

- [ ] **Use bounded queues and load-aware admission at audio input, orchestrator, and provider limits** — backpressure prevents latency collapse under load.
      Evidence: REL-09. Canonical: `_clones/agents/livekit-agents/livekit/agents/worker.py:778` (load-aware admission — the genuine backpressure primitive). NB: `_clones/pipecat/src/pipecat/transports/base_input.py:226` is an **unbounded** `asyncio.Queue()` — no OSS clone bounds the audio-in queue, so bounding it + admission control is Syrinx work.
      Target/number: queue bounds are deployment-specific; expose queue depth, drops, and admission rejections as metrics. (Bounded audio-in queue = greenfield; see Greenfield Gaps.)

- [ ] **Classify incidents by Deepgram's failure-mode catalog before tuning** — most voice bugs surface at capture/transcription/reasoning/synthesis/playback boundaries.
      Evidence: REL-10. Canonical: source-only catalog in `_sources/pdf/deepgram-voice-agent.parsed.md`; clone telemetry for layers at `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:20-105`.
      Target/number: runbook begins with layer classification; do not tune VAD, codecs, or endpointing until the responsible layer is identified.

- [ ] **Build STT/TTS fallback adapters with availability events and background recovery** — failover should skip dead providers until they recover.
      Evidence: REL-08, STT-07. Canonical: `_clones/agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:95-103`, `_clones/agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:175-248`.
      Target/number: emit `*_availability_changed`; probe recovery in the background; when all providers are down, fail loudly and trigger degradation.

## 8. Observability

- [ ] **Emit one canonical turn-boundary event stream with monotonic timestamps and session ids** — all higher-level latency and quality metrics should derive from the same raw events.
      Evidence: OBS-01, OBS-07. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/agent_session.py:1639` (`user_input_transcribed`; `user_state_changed`/`agent_state_changed` boundary events), `_clones/pipecat/src/pipecat/observers/user_bot_latency_observer.py:205,236,245,251,278` (tracks VADUserStarted/UserStopped/BotStartedSpeaking frames).
      Target/number: events include UserStartedSpeaking, UserStoppedSpeaking, AgentThinking, AgentStartedSpeaking, AgentAudioDone, interruption, and function/tool lifecycle where relevant.

- [ ] **Compute canonical v2v as AgentStartedSpeaking - UserStoppedSpeaking** — this is the user-perceived turn latency number.
      Evidence: OBS-02, LAT-01. Canonical: `_clones/agents/livekit-agents/livekit/agents/voice/agent_activity.py:2768-2771`, `_clones/pipecat/src/pipecat/observers/user_bot_latency_observer.py:292`.
      Target/number: anchor UserStoppedSpeaking to raw VAD silence minus hangover so endpointing policy remains inside the metric.

- [ ] **Separate transcription_delay from end_of_utterance_delay** — STT slowness and endpointing conservatism require different fixes.
      Evidence: OBS-05. Canonical: `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:94-105`, `_clones/agents/livekit-agents/livekit/agents/telemetry/otel_metrics.py:38-47`.
      Target/number: both fields emitted per turn; refuse to compute when VAD timestamps are unreliable.

- [ ] **Export per-stage histograms and traces with session-id, speech-id, request-id, provider, model, and region tags** — root cause needs correlation across logs, metrics, and provider calls.
      Evidence: OBS-04, OBS-07, OBS-08. Canonical: `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:20-81`, `_clones/agents/livekit-agents/livekit/agents/telemetry/otel_metrics.py:23-47`.
      Target/number: Prometheus histograms for SLOs; OTel spans for conversation -> turn -> STT/LLM/TTS stage drilldown.

- [ ] **Track VAQI constituents even before defining the rollup** — interruptions, missed responses, and latency are the production quality surface.
      Evidence: OBS-03, TURN-11. Canonical: `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:166-175`.
      Target/number: count interruptions separately from backchannels; VAQI aggregate has no OSS implementation and must be Syrinx-defined.

- [ ] **Gate releases with replay, load, fault injection, and turn-level diagnostics** — probabilistic voice behavior needs distribution testing, not golden-output tests only.
      Evidence: OBS-09, REL-10. Canonical: OSS clones emit telemetry but do not ship a full harness; LiveKit diagnostic inputs at `_clones/agents/livekit-agents/livekit/agents/voice/audio_recognition.py:1185`, `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:166`.
      Target/number: assert P95/P99 distributions and failure recovery, not mean latency alone.

- [ ] **Run synthetic probes and real-user monitoring in production** — scheduled probes catch known regressions, live traffic reveals network/user/provider variance.
      Evidence: OBS-10. Canonical: `_clones/agents/livekit-agents/livekit/agents/metrics/base.py:115-157` for realtime metrics; no synthetic/RUM harness in OSS clones.
      Target/number: scheduled representative calls plus live histograms per provider/region/model.

## 9. Multilingual & Audio Preprocessing

- [ ] **Prefer unified multilingual STT streams where continuity matters** — code-switching should not reset the session or discard context.
      Evidence: LANG-01, LANG-03. Canonical: `_clones/pipecat/src/pipecat/services/deepgram/stt.py:691-694`, `_clones/voice-ai/api/assistant-api/internal/transformer/deepgram/internal/stt_callback.go:57-58`.
      Target/number: carry language code + confidence on transcript frames; detection is a probabilistic signal, not a hard fork.

- [ ] **Propagate language metadata through transcript, LLM response language, and TTS voice selection** — language routing belongs in the pipeline contract, not side-channel guesses.
      Evidence: LANG-02, LANG-03. Canonical: `_clones/pipecat/src/pipecat/services/tts_service.py:769-773` (voice setting update), `_clones/agents/livekit-agents/livekit/agents/voice/agent_session.py:1302` (agent update).
      Target/number: automatic language-triggered TTS switching is not implemented by any clone end-to-end; treat as Tier-1 greenfield.

- [ ] **Run denoising/preprocessing before VAD and STT where the deployment noise profile requires it** — VAD and STT cannot recover signal that preprocessing should have cleaned.
      Evidence: STT-11, TURN-12. Canonical: `_clones/pipecat/src/pipecat/audio/filters/krisp_viva_filter.py:35`, `_clones/pipecat/src/pipecat/audio/filters/rnnoise_filter.py:30`, `_clones/voice-ai/api/assistant-api/internal/denoiser/denoiser.go:27`.
      Target/number: Krisp/RNNoise selectable; Pipecat Krisp uses 10 ms frames, RNNoise requires 48 kHz path per note.

- [ ] **Maintain persona, pacing, and pronunciation consistency across languages** — voice quality regressions are trust regressions even when transcription is correct.
      Evidence: LANG-04, TTS-10. Canonical: no automated clone implementation for cross-language voice matching; pronunciation hooks at `_clones/pipecat/src/pipecat/services/cartesia/tts.py:192-204`.
      Target/number: same latency and barge-in SLAs per language; localized prompts and acknowledgements are authored, not live-translated (source-only).

## Greenfield Gaps

- **Dynamic hedging and bandit routing:** LAT MOC open questions state no clone implements Vapi-style per-endpoint `mean + k*sigma` hedging or bandit exploit/explore routing. Syrinx must design this from per-provider histograms after Tier-0 observability exists. Evidence: `wiki/lat-map.md` open questions; LAT-06, LAT-07.
- **Supervised VAD subprocess with auto-respawn:** REL MOC open questions state Vapi describes VAD isolation, but Pipecat/LiveKit run VAD in-process and no OSS clone ships the full supervised subprocess pattern. Evidence: `wiki/rel-map.md` open questions; REL-11.
- **VAQI rollup and missed-response window:** OBS MOC states clones expose constituents but no clone ships a VAQI aggregate or numeric missed-response window. Syrinx must define the I/M/L formula and tolerance bands. Evidence: `wiki/obs-map.md` open questions; OBS-03.
- **Replay/load/fault-injection harness:** OSS clones provide metrics, not a production test harness. Syrinx must build recorded-audio replay, load-tail assertions, provider-fault injection, and turn diagnostics. Evidence: `wiki/obs-map.md` open questions; OBS-09.
- **Dynamic multilingual voice switching:** LANG MOC states no clone wires language detection to automatic mid-session TTS hot-switching without an audio gap. Syrinx must build language metadata frames, voice mapping, warm-up, and gap handling. Evidence: `wiki/lang-map.md` open questions; LANG-02, LANG-03.
- **µ-law passthrough:** XPORT/TTS MOC open questions note Deepgram recommends avoiding transcoding when providers accept µ-law, but Pipecat's PCM pipeline transcodes at the edge. Syrinx should benchmark native µ-law STT/TTS passthrough for telephony. Evidence: `wiki/xport-map.md`, `wiki/tts-map.md` open questions; XPORT-04, TTS-06.
- **S2S audit shadow transcription:** OBS MOC notes Together recommends a parallel transcription model for speech-to-speech auditability, but no clone implements the full pattern. Evidence: `wiki/obs-map.md` open questions; OBS-10.
- **Pre-TTS guardrail placement:** ARCH/LAT notes identify the irreversibility requirement, but clone code paths were not traced to a verified guardrail-before-TTS implementation. Syrinx must design and budget it explicitly. Evidence: ARCH-11, LAT-13; clone implementation unverified.

## Numbers Reference Card

| Area | Number / target | Evidence | Canonical reference |
|---|---:|---|---|
| Internal STT rate | 16 kHz linear16 mono | XPORT-02, STT-04 | `_clones/pipecat/src/pipecat/frames/frames.py:855` |
| Internal TTS rate | 24 kHz PCM default | XPORT-02 | `_clones/pipecat/src/pipecat/frames/frames.py:856` |
| WebRTC / Opus rate | 48 kHz, 20 ms Opus frames | XPORT-09, XPORT-12 | `_clones/voice-ai/api/assistant-api/internal/channel/webrtc/internal/types.go:11-16` |
| Telephony | 8 kHz mono µ-law/A-law default | XPORT-04 | `_clones/pipecat/src/pipecat/serializers/twilio.py:255-258` |
| Audio frame size | 10-50 ms; prefer 20 ms egress | XPORT-05 | `_clones/pipecat/src/pipecat/transports/base_transport.py:69` |
| Pipecat output default | 4 x 10 ms = 40 ms writes | XPORT-05 | `_clones/pipecat/src/pipecat/transports/base_transport.py:69` |
| Jitter buffer | about 100 ms target, 100-200 ms band | XPORT-06, TTS-07 | LiveKit 200 ms cited in MOC |
| Resampler state clear | 0.2 s inactivity | XPORT-03 | `_clones/pipecat/src/pipecat/audio/resamplers/soxr_stream_resampler.py:27` |
| Deepgram idle timeout | 10 s; keepalive every 5 s | REL-03 | `_clones/pipecat/src/pipecat/services/deepgram/stt.py:652-663` |
| Output end silence | 2 s tail | XPORT-08 | `_clones/pipecat/src/pipecat/transports/base_transport.py:72` |
| VAD defaults | confidence 0.7, start 0.2 s, stop 0.2 s, min volume 0.6 | TURN-01 | `_clones/pipecat/src/pipecat/audio/vad/vad_analyzer.py:24-27` |
| VAD pre-roll | 500 ms default | STT-12 | `_clones/pipecat/src/pipecat/services/google/gemini_live/llm.py:123` |
| SmartTurn fallback silence net | 3 s, model cut 0.5, max segment 8 s | TURN-05 | `_clones/pipecat/src/pipecat/audio/turn/smart_turn/base_smart_turn.py:27` |
| LiveKit interruption | min duration 0.5 s; false resume timeout 2.0 s; boundary 1.0/1.0 s | BARGE-06, TURN-11 | `_clones/agents/livekit-agents/livekit/agents/voice/turn.py:117-125` |
| JS interruption classifier | threshold 0.5, 2 x 25 ms frames, 0.5 s prefix | BARGE-06, TURN-11 | `_clones/agents-js/agents/src/inference/interruption/defaults.ts:7-10` |
| Barge-in sequence | <100 ms target source-only | BARGE-02 | no clone measures it; instrument in Syrinx |
| TTS pacing | first sentence immediate; later flush at <=5.0 s remaining; 300 chars | TTS-05 | `_clones/agents/livekit-agents/livekit/agents/tts/stream_pacer.py:20-35` |
| TTS RTF | <1.0 | TTS-04 | no clone direct gauge; add one |
| Human v2v ladder | 300 ms natural; >500 ms noticeable; ~1200 ms flow break; 1-2 s hang-up risk | LAT-03 | source-only |
| Budget split source | ASR ~300 ms; LLM 200-900 ms; TTS ~400 ms | LAT-04 | source-only |
| Network co-location | ~75 ms remote hop -> ~5 ms co-located | LAT-08 | source-only |
| Pipeline heartbeat | 1.0 s heartbeat; 10.0 s monitor alarm | REL-05 | `_clones/pipecat/src/pipecat/pipeline/worker.py:87-88` |
| Input audio watchdog | 0.5 s | REL-05 | `_clones/pipecat/src/pipecat/transports/base_input.py:31` |
| Rapid failure breaker | 3 quick deaths under 5 s | REL-02 | `_clones/pipecat/src/pipecat/services/websocket_service.py:31-36` |
| Reconnect backoff cap | ~10 s | REL-01 | `_clones/pipecat/src/pipecat/utils/network.py:10`, `_clones/agents/livekit-agents/livekit/agents/worker.py:1096` |
| Drain timeout | 1800 s / 30 min | REL-07 | `_clones/agents/livekit-agents/livekit/agents/worker.py:203` |
| STT fallback attempt timeout | LiveKit default 10.0 s | REL-08 | `_clones/agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:53` |

