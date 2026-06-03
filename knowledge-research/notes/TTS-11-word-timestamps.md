---
id: TTS-11
title: Word-timestamp emission — align spoken text to audio for context reconstruction on barge-in
domain: TTS
tags: [word-timestamps, alignment, barge-in, context, assistant-aggregation]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/services/tts_service.py:1233, pipecat/src/pipecat/services/elevenlabs/tts.py:336, pipecat/src/pipecat/services/cartesia/tts.py:680]
---

**Claim (one line):** Streaming TTS providers return per-word (or per-char) timestamps aligned to the audio; the orchestrator uses them to know **exactly how much was actually spoken** before an interruption, so the assistant's context reflects only the spoken prefix.

**Detail.** When the bot is cut off mid-response, the LLM context must record what was *spoken*, not the full generated text. Pipecat builds this from word timestamps: `add_word_timestamps` / `_add_word_timestamps` stamp each word with a presentation timestamp (PTS) and push word-level `TTSTextFrame`s through the transport clock queue, tracking `_word_last_pts` (tts_service.py:1185-1264). Cartesia returns `word_timestamps:{words,start}` on the socket (code reads only `words`+`start`), normalized then fed to `add_word_timestamps(processed_timestamps, ctx_id, includes_inter_frame_spaces=...)` (cartesia/tts.py:680-688). ElevenLabs returns **character** alignment (`chars`, `charStartTimesMs`) which `calculate_word_times` folds into word timestamps, carrying a partial word across chunk boundaries (elevenlabs/tts.py:336-365); it prefers `normalized_alignment` only when a pronunciation dictionary is active to avoid duplicated words (elevenlabs/tts.py:262-296). The assistant aggregation frame is stamped `pts = _word_last_pts + 1` so it flushes only **after** every spoken word frame is seen (tts_service.py:819-821), guaranteeing the context contains exactly the spoken prefix. Deepgram exposes the boundary as the `AgentAudioDone` lifecycle event (deepgram-ebook L562-566).

**Prior-art divergence.** Cartesia/Deepgram emit **word**-level timestamps natively; ElevenLabs emits **character** alignment that must be reassembled into words (handles streaming partial-word carryover). Providers without timestamps use `InterruptibleTTSService` (no per-word context — coarser interruption boundary, reconnect-based; [[TTS-08-interruptible-tts]]). LiveKit carries aligned transcript via `push_timed_transcript`/`TimedString` in the StreamAdapter (stream_adapter.py:124) and advertises `aligned_transcript=True` capability.

**Implication for Syrinx.** Prefer TTS providers with word/char timestamps; use them to (a) drive accurate spoken-prefix context on barge-in and (b) emit synchronized transcript frames for UI captions. This is the TTS→BARGE handoff.

Links: [[TTS-08-interruptible-tts]] [[TTS-03-sentence-aggregation]] [[BARGE-05-context-reconstruction-vapi]] [[wiki/tts-map]]
