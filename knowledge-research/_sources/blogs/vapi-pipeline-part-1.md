# How We Built Vapi's Voice AI Pipeline: Part 1
Source: https://vapi.ai/blog/how-we-built-vapi-s-voice-ai-pipeline-part-1
Author: Abhishek Sharma, 2025-08-21

## The Flawed Foundation — "Batch Processing Cascade"
Traditional voice automation = intent-based rigid decision tree, listened for keywords. Reliable but brittle.
> IMAGE (traditional_system_bad.png).

Modern LLM pipeline but **sequential**: `Speech-to-Text (wait) → NLP (wait) → Text-to-Speech (wait)`.
- **STT:** wait for user to finish completely → send entire audio chunk → wait for full transcript.
- **LLM:** send complete transcript → wait for full response.
- **TTS:** send complete text → wait for entire audio → play.

**This cascade of waiting creates over 4 seconds of dead air between turns.** Treats conversation as isolated transactions, not continuous flow.

## Solution: stop thinking in batches, think in streams
> IMAGE (batch_vs_stream.png).
Process audio the way humans do: continuously, in real time, making decisions on partial information. **Re-architect everything to handle audio in 20ms chunks instead of multi-second files.**

## The Vapi Streaming Pipeline — three parallel streams
> IMAGE (vapi_streaming_timeline.png): timeline of the three streams overlapping.

### 1. Audio Input Stream
Processes audio in **20ms chunks as it arrives**. First critical decisions:
- **Voice Activity Detection:** is someone actually speaking vs background noise?
- **Audio Preprocessing:** clean up audio to improve transcription accuracy.
- **Real-time Buffering:** pass clean chunks downstream with minimal delay.

### 2. Transcription Stream
**Streaming STT providing partial results as the user speaks** ("I need to..." → "I need to schedule..." → "...an appointment for Tuesday"). Each partial fed to the next stage immediately rather than waiting for the complete sentence.

### 3. Response Generation Stream
LLM starts working with partial info, generates incrementally. **Endpointing model predicts when the user has likely finished their thought** → send the complete utterance to the LLM at that moment. **If the model is wrong and the user continues, scrap that LLM request and start a new one with the updated transcript.** This **"predict and scrap"** method = responsiveness without premature/nonsensical responses.

## Where Things Get Complex
> IMAGE (where_things_go_complex.png).
Coordinating three parallel streams is where most implementations fall apart. Scenario: user says "I need to schedule..." then pauses to think — wait for more audio? start generating? what if they restart as the AI begins to respond? Fixed timeouts, simple buffering, basic state machines **didn't work**.

Every component hides immense complexity:
- **VAD:** distinguishing a pause from background TV.
- **Turn Detection:** deciding when a partial transcript is confident enough.
- **Interruptions:** cutting off a response the moment the user jumps back in.
- **Audio Handling:** echo, cross-talk, bad cell networks.

**Breakthrough insight:** coordination between streams is a **conversation-understanding problem** — each stream must be aware of what the others are doing and what it means for the conversation as a whole.
