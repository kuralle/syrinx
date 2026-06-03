---
id: STT-02
title: Partial → final transcript lifecycle (interim/preflight/final)
domain: STT
tags: [interim, final, partials, frames, events]
sources: [deepgram-ebook, vapi-pipeline-2, diagrams]
code_refs: [pipecat/src/pipecat/services/deepgram/stt.py:685, agents/livekit-agents/livekit/agents/stt/stt.py:33]
---

**Claim (one line):** A streaming STT emits a growing sequence of *interim/partial* hypotheses that may be revised, then exactly one *final* transcript per utterance once the recognizer is confident the text won't change.

**Detail.** Deepgram's glossary: "Partial transcripts are interim ASR outputs produced while the user is still speaking. Final transcripts are confirmed at the end of an utterance … Partial results enable earlier reasoning and lower perceived latency" (deepgram-ebook:1955-1959). Vapi's streaming-timeline diagram shows partials literally growing word-by-word ("I need to…" → "I need to schedule." → "I need to schedule an") concurrently with response generation (diagrams:15-16). In Pipecat, the message callback branches on `message.is_final`: a final result becomes a `TranscriptionFrame`, an interim becomes an `InterimTranscriptionFrame` (`deepgram/stt.py:689-723`). LiveKit's `SpeechEventType` enumerates the lifecycle with a notable middle state — `INTERIM_TRANSCRIPT`, then **`PREFLIGHT_TRANSCRIPT`** ("stable enough to be used for preemptive generation" but "the same transcript may still be updated"), then `FINAL_TRANSCRIPT` (`stt/stt.py:37-46`). Rapida tags each emitted `SpeechToTextPacket` with `Interim: true/false` off Deepgram's `mr.IsFinal` (`deepgram/internal/stt_callback.go:81-139`).

**Prior-art divergence.** LiveKit adds a third tier (`PREFLIGHT`) between interim and final, explicitly for preemptive/speculative LLM generation — a finer split than Pipecat's binary interim/final or Rapida's `Interim` bool. Deepgram Flux collapses the lifecycle onto *turn* events (`Update`/`EagerEndOfTurn`/`EndOfTurn`) rather than interim/final flags — see [[TURN-04-flux-event-model]] and [[STT-09-streaming-native-vs-whisper]].

**Implication for Syrinx.** Treat partials as disposable display/speculation signals; only the final transcript is authoritative for the agent. A preflight tier is worth it if we do speculative LLM prefill.

Links: [[STT-01-streaming-vs-batch]] [[STT-03-confidence-filtering]] [[STT-10-final-transcript-delivery]] [[BARGE-06-confidence-gated-interruption]]
