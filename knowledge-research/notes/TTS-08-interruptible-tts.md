---
id: TTS-08
title: TTS must be interruptible & cancellable — flush text buffer and cancel server context
domain: TTS
tags: [interruption, barge-in, cancel, buffer-flush]
sources: [deepgram-ebook, together-talk]
code_refs: [pipecat/src/pipecat/services/tts_service.py:902, pipecat/src/pipecat/services/cartesia/tts.py:609, voice-ai/api/assistant-api/internal/transformer/cartesia/tts.go:197]
---

**Claim (one line):** On barge-in the TTS must stop immediately — drop the aggregator's buffered text, cancel the provider's in-flight synthesis context, and discard queued audio — because *"you can't take back spoken words."*

**Detail.** Deepgram: *"TTS must be interruptible, cancellable, and replaceable at any moment. Voice agents that cannot stop themselves on demand will never feel conversational"* (deepgram-ebook L558-561), and playback cancellation must be **explicit** so buffers clear (L572-574). Together adds the irreversibility argument: guardrails must sit before TTS because *"you can't take back spoken words"* (together-talk L42). In code, Pipecat's `_handle_interruption` does the full teardown: `_text_aggregator.handle_interruption()` (drops buffered partial sentence), clears the frame sequencer, resets word timestamps, stops the audio-context task, drains the serialization queue keeping only uninterruptible frames (e.g. `FunctionCallResultFrame`), and calls `on_audio_context_interrupted` per active context (tts_service.py:902-924). For Cartesia that sends a per-context cancel: `{"context_id": ctx, "cancel": true}` (cartesia/tts.py:609-615). Rapida's Cartesia transformer handles `TextToSpeechInterruptPacket` by clearing the context id and **closing + reconnecting** the websocket (cartesia/tts.go:197-216). Pipecat's `InterruptibleTTSService` uses the same disconnect/reconnect tactic for providers that lack a cancel message and only when `_bot_speaking` (tts_service.py:1620-1624).

**Prior-art divergence.** Two cancellation mechanisms: (1) **explicit cancel message** on a persistent socket (Cartesia `cancel:true`) — cheap, keeps the connection warm; (2) **disconnect+reconnect** (Pipecat `InterruptibleTTSService`, Rapida) — works for any provider but pays reconnect latency on the next turn. Pipecat prefers (1) when the provider supports word-timestamp contexts, falling back to (2) otherwise.

**Implication for Syrinx.** Wire barge-in to flush the sentence buffer *and* cancel the provider context in the same handler; prefer an explicit cancel message over reconnect to keep the socket warm. Coordinates with BARGE-domain playback flush.

Links: [[TTS-03-sentence-aggregation]] [[TTS-05-sentence-pacing]] [[TTS-11-word-timestamps]] [[BARGE-02-interruption-sequence]] [[wiki/tts-map]]
