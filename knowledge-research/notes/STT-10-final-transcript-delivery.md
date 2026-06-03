---
id: STT-10
title: Delivering the final transcript to the agent/LLM
domain: STT
tags: [final, handoff, frames, aggregation, eot]
sources: [deepgram-ebook, vapi-pipeline-2]
code_refs: [pipecat/src/pipecat/services/deepgram/stt.py:702, pipecat/src/pipecat/services/deepgram/flux/base.py:676]
---

**Claim (one line):** The STT stage's contract output is the final transcript handed to the agent at end-of-turn — wrapped in a typed, finalized frame/event that the LLM aggregator consumes — and that handoff is the boundary between the voice engine and the agent.

**Detail.** This is the README boundary: "the transcript out … is delivered to the agent cleanly." Deepgram formalizes it as a callback the orchestrator implements: `on_user_end_of_turn(transcript)` feeds `input=transcript` to the reasoning layer (deepgram-ebook:613-616). In code the final transcript is a distinct typed frame. Pipecat's classic Deepgram pushes a `TranscriptionFrame(transcript, user_id, timestamp, language, result=message)` only on `is_final` (`deepgram/stt.py:702-710`), while interims go out as `InterimTranscriptionFrame` and are *not* the handoff. Flux makes the end-of-turn the explicit delivery point: `_handle_end_of_turn` pushes a `TranscriptionFrame(..., finalized=True)` and then broadcasts `UserStoppedSpeakingFrame` (`flux/base.py:676-693`) — the `finalized=True` flag tells the downstream user-aggregator the turn is complete and the LLM may run. LiveKit delivers the same via a `SpeechEvent(type=FINAL_TRANSCRIPT, alternatives=[SpeechData(text=…, confidence=…)])` (`agents/.../stt/stt.py:44, 112-116`). Rapida emits a final `SpeechToTextPacket{Interim:false, Confidence:…}` plus an `stt_latency_ms` metric measured from speech-swap-start (`stt_callback.go:81-115`).

**Prior-art divergence.** Pipecat couples the final transcript tightly to turn frames (`finalized=True` + `UserStoppedSpeakingFrame`), so the LLM aggregator triggers on the turn boundary, not on the transcript alone. Vapi's "greedy inference" sends the *predicted-final* utterance early and scraps+restarts if the user continues (vapi-pipeline-2:47) — delivering speculatively before the true final. Deepgram Flux's `EagerEndOfTurn` (pushed as an *interim* frame, `flux/base.py:696-731`) is the same speculative-prefill primitive.

**Implication for Syrinx.** Define one clean STT→agent contract: a finalized transcript frame carrying text + confidence + language + per-stage latency, fired at the turn boundary. Speculative early delivery (eager EOT) is an opt-in optimization layered on top, not the default path.

Links: [[STT-02-partial-final-lifecycle]] [[STT-06-wer-unrecoverable]] [[STT-03-confidence-filtering]] [[TURN-04-flux-event-model]] [[ARCH-01-frame-pipeline-model]]
