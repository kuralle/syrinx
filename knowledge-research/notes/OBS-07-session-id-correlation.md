---
id: OBS-07
title: Session-id correlation — one identifier links transcripts, events, errors, traces
domain: OBS
tags: [observability, session, correlation, logging, tracing, debugging]
sources: [deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/metrics/base.py:23, pipecat/src/pipecat/utils/tracing/turn_trace_observer.py:47]
---

**Claim (one line):** Every conversation carries one stable session/conversation id that stitches its transcript, turn events, per-stage metrics, errors, and trace spans into a single reconstructable timeline — without it, a problematic call can't be replayed or root-caused across systems.

**Detail.** Deepgram: "Each conversation should carry a unique session identifier that links transcripts, events, and errors across systems" (deepgram-ebook line 1057–1058); structured logging then "enables reconstruction of problematic interactions" capturing both system events (retries, timeouts, function calls) and conversational events (speech boundaries, interruptions) (line 1062–1065). The clones thread several correlating keys. LiveKit keys per-request metrics with `request_id` and `speech_id`/`segment_id` (`metrics/base.py:23,33,79`) so a TTS metric can be tied back to the LLM generation and the user turn that triggered it; provider request-ids are also attached to the user-turn span (`audio_recognition.py:1218`, `ATTR_PROVIDER_REQUEST_IDS`). Pipecat's `TurnTraceObserver` accepts a `conversation_id` and nests every turn span — and the service STT/LLM/TTS spans under it — inside a single conversation span for the whole session (`turn_trace_observer.py:47–51`), so the trace tree *is* the session timeline. Tracing scope is pipeline-level via `TracingContext` (`turn_trace_observer.py:69`).

**Prior-art divergence.** LiveKit propagates *fine-grained* correlation ids (request_id per provider call, speech_id per agent utterance, segment_id per TTS segment) — debugging granularity at the sub-turn level. Pipecat propagates a *coarse* `conversation_id` and relies on the span-tree hierarchy for within-session structure. Deepgram specifies only the session-id contract at the wire/log layer. The union is the right target: a coarse session-id for cross-system joins + fine request/speech-ids for within-session causality.

**Implication for Syrinx.** Mint a session-id at connect and stamp it on every emitted event, metric, log line, and trace span; additionally carry a per-utterance speech-id and per-provider request-id so a slow turn can be drilled from "session X felt laggy" down to "the Cartesia TTS request on turn 7 had ttfb 900ms." Redact transcripts per privacy controls (deepgram-ebook line 1066–1068).

Links: [[OBS-01-event-instrumentation-turn-boundaries]] [[OBS-08-otel-traces-spans]] [[OBS-04-per-stage-latency-metrics]] [[OBS-09-replay-load-fault-injection]]
