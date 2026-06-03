# How We Built Vapi's Voice AI Pipeline: Part 2
Source: https://vapi.ai/blog/how-we-built-vapi-s-voice-ai-pipeline-part-2
Author: Abhishek Sharma, 2025-09-16

Building the components that tame chaos (background noise, unpredictable pauses, bad cell service) before it reaches the LLM.

## Problem #1: Voice Activity Detection
> IMAGE (VAD_diagram.png): audio flow through VAD.
Job: detect when someone is speaking. Volume threshold is wrong (can't separate the speaker you want from audio you want to ignore). Vapi VAD = **state machine, 4 states, different thresholds for starting vs stopping (hysteresis) to prevent nervous switching**:
- **QUIET:** no meaningful audio (confidence below threshold).
- **STARTING:** speech beginning detected, awaiting confirmation (**~200ms sustained detection**).
- **SPEAKING:** active speech confirmed.
- **STOPPING:** speech ending detected, awaiting confirmation (**~800ms sustained silence**).
Creates a rolling average responsive to changes while filtering noise. Still not enough — every person speaks differently. **Maintains a 30-second rolling window of audio levels, uses the 85th percentile as a dynamic baseline**, auto-adjusting to quiet/loud speakers and noisy environments.

**Reliability:** VAD runs in a **separate process**. Audio flows between processes via **stdin/stdout pipes**, probability scores returned as ASCII strings. When the process fails, the system **automatically respawns it without dropping the conversation**.

## Problem #2: Audio Preprocessing
> IMAGE (problem_2.png): preprocessing pipeline filtering background noise.
Phone calls are messy. Biggest challenge = **background speech** (standard denoisers preserve human speech including TV audio you don't want). Adaptive thresholding system that learns the difference between speakers in real time:
- **Baseline Tracking:** RMS amplitude over **3-second rolling windows** using 20ms chunks.
- **Dynamic Thresholds:** 85th percentile of audio-level distribution as filtering threshold.
- **Continuous Adaptation:** update baseline **every 100ms via exponential smoothing**.
- **Media Detection:** switch to more aggressive filtering when consistent background audio detected.
Core insight: **background speech is typically quieter than the primary speaker.** Add **500ms grace period** to avoid cutting off the start of words. Static fallback thresholds ~**-35dB**; baseline offsets auto-adjust when TV/music detected.

## Problem #3: Streaming Speech Recognition
> IMAGE (Partial_transcript_filter_chain.png): partial-transcript filter chain.
Streaming STT forces decisions with incomplete info. **Confidence-based filtering with multiple decision points:**
- **Basic Filtering:** very low-confidence transcripts discarded automatically.
- **Interruption Decisions:** only higher-confidence transcripts can interrupt the AI while it's speaking.
- **Edge Case Handling:** single-letter artifacts and common false positives filtered out.
Multiple STT providers with **automatic fallback** if primary fails; handle provider-specific quirks while keeping consistent behavior.

## Problem #4: Endpointing
> IMAGE (conversational_context.png): conversational context determining end of speech.
Determining when someone finished = the most underestimated challenge. Simple timeout is robotic (too early cuts people off, too late = dead air). Approaches, usable individually or combined:
- **Rule-Based Endpointing:** custom delays by message content patterns (different timeouts for messages ending with numbers vs punctuation vs plain statements).
- **Intelligent Endpointing:** ML-based prediction considering conversation context, speech patterns, timing → optimal wait time.
- **Custom External Models:** integration with external endpointing services for domain logic.
- **Regex Pattern Matching:** match against assistant responses, user inputs, or both to trigger context-specific endpointing.
System auto-chooses best method with intelligent fallbacks. **This single change reduced premature interruptions by 73% vs a fixed timeout.**

## Problem #5: Coordination
First four components turn messy audio into a clean prediction; this is about acting on it and handling wrong predictions.

**Greedy Inference:** when we think the user is done, immediately send their utterance to the LLM to start generating. If wrong and they continue, instantly cancel and restart with the complete updated utterance. **The user never hears the scrapped attempt.**

**Interruption (barge-in) sequence — must complete in under 100ms:**
1. VAD detects speech start, emits events.
2. LLM request aborted.
3. TTS generation stops immediately.
4. **Audio buffers cleared to prevent glitchy playback.**
5. System switches to listening mode to capture new input.

**Context reconstruction (trickiest):** LLMs generate faster than we can speak, so audio is often queued. **Use word-level timestamps from the TTS provider to reconstruct exactly which words the user actually heard before they interrupted**, keeping conversation context synchronized with the user's experience.

Coordinated through an **event-driven architecture**. (Part 3 = production: voicemail detection, DTMF, perf optimization, testing/monitoring a non-deterministic system.)
