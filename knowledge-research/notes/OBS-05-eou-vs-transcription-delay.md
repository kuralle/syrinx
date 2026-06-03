---
id: OBS-05
title: EOU delay vs transcription delay — LiveKit splits the two halves of "user stopped"
domain: OBS
tags: [observability, endpointing, eou, transcription, turn-taking, metrics]
sources: [deepgram-ebook, modal-v2v]
code_refs: [agents/livekit-agents/livekit/agents/metrics/base.py:94, agents/livekit-agents/livekit/agents/voice/audio_recognition.py:1194, agents-js/agents/src/metrics/base.ts:101]
---

**Claim (one line):** The interval between the user going silent and the agent being *allowed* to reply is two separable costs — **transcription_delay** (silence → final transcript available) and **end_of_utterance_delay** (silence → turn-end *decision*) — and LiveKit's `EOUMetrics` measures both independently so you can attribute the wait to STT lag vs. endpointing policy.

**Detail.** LiveKit's `EOUMetrics` (`metrics/base.py:94–110`) carries: `end_of_utterance_delay` = "time between end of speech from VAD and the decision to end the user's turn"; `transcription_delay` = "time taken to obtain the transcript after the end of the user's speech"; plus `on_user_turn_completed_delay`. They are computed in `audio_recognition.py` against three timestamps — `speech_start_time`, `last_speaking_time` (VAD stop), `last_final_transcript_time`: `transcription_delay = max(last_final_transcript_time − last_speaking_time, 0)` and `end_of_turn_delay = time.time() − last_speaking_time` (`audio_recognition.py:1194–1195`). Crucially, if VAD was unreliable (any of the three timestamps missing) LiveKit **refuses to compute** and emits nothing — "better than providing likely wrong values" (`audio_recognition.py:1185–1186`). These feed OTel histograms `lk.agents.turn.transcription_delay` and `…end_of_turn_delay` (`otel_metrics.py:38,43`). The JS port mirrors the fields and adds `lastSpeakingTimeMs` to the event (`agents-js/.../metrics/base.ts:101–121`). This is the metric that makes Modal's insight measurable — "the only thing that matters for total v2v latency is the **final transcript time**" (modal-v2v line 33) is exactly `transcription_delay`.

**Prior-art divergence.** LiveKit is the only clone to *split endpointing from transcription* as two named metrics — Pipecat folds both into the `user_turn_secs` of `LatencyBreakdown` ("includes VAD silence detection, STT finalization, and any turn analyzer wait", `user_bot_latency_observer.py:99–102`), a single lumped number. Deepgram's VAQI "L" also lumps it into the end-to-end figure. LiveKit's split is the more diagnostic shape: it tells you whether to tune the STT or the turn-detector.

**Implication for Syrinx.** Emit transcription_delay and endpointing_delay as *separate* fields, not one "time to respond." When e2e latency regresses, this split immediately says whether STT got slower or the turn model got more conservative. Copy LiveKit's "refuse to compute on unreliable VAD" rule — a wrong latency number poisons the SLO dashboard.

Links: [[OBS-02-canonical-timing-metric]] [[OBS-04-per-stage-latency-metrics]] [[TURN-03-semantic-vs-timeout-endpointing]] [[STT-08-segment-then-transcribe]]
