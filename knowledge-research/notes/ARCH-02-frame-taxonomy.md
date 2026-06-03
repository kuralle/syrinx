---
id: ARCH-02
title: Pipecat frame taxonomy — Audio / Text / Transcription / Control / lifecycle
domain: ARCH
tags: [frames, taxonomy, audio, transcription, interruption]
sources: [modal-v2v]
code_refs: [pipecat/src/pipecat/frames/frames.py:54, pipecat/src/pipecat/frames/frames.py:962]
---

**Claim (one line):** Pipecat models every signal in the speech path — raw audio, partial/final transcripts, LLM tokens, TTS audio, and conversational lifecycle events — as a distinct `Frame` subclass, so coordination is just frame routing.

**Detail.** All frames inherit `Frame` (id, name, `pts` presentation timestamp in ns, metadata, transport_source/destination) (`frames.py:54-88`). The three base categories are `SystemFrame` (immediate, interrupt-immune), `DataFrame` (ordered, cancelled by interruption), `ControlFrame` (ordered control/settings) (`frames.py:94-128`). Speech-path frames:
- **Audio:** `InputAudioRawFrame`/`UserAudioRawFrame` are SystemFrames carrying PCM `audio: bytes`, `sample_rate`, `num_channels` (`frames.py:150-167,1226-1287`); `OutputAudioRawFrame`/`TTSAudioRawFrame` are DataFrames for egress (`frames.py:190-242`).
- **Transcription:** `TranscriptionFrame` (final) and `InterimTranscriptionFrame` (partial) both subclass `TextFrame`→`DataFrame` (`frames.py:414-464`) — the partials Vapi/Together describe as the streaming-STT feel.
- **LLM/TTS:** `LLMTextFrame` tokens (`frames.py:332`), `TTSTextFrame`/`AggregatedTextFrame` for sentence aggregation (`frames.py:376-413`), `TTSStartedFrame`/`TTSStoppedFrame` control (`frames.py:1850-1877`).
- **Lifecycle (all SystemFrames):** `UserStartedSpeakingFrame`/`UserStoppedSpeakingFrame` (`frames.py:962-983`), `VADUserStartedSpeakingFrame`/`VADUserStoppedSpeakingFrame` (`frames.py:1034-1063`), `BotStartedSpeakingFrame`/`BotStoppedSpeakingFrame`/`BotSpeakingFrame` (`frames.py:1064-1098`), and `InterruptionFrame` (`frames.py:951`).
- **Boundary:** `StartFrame` (first frame, `frames.py:838`), `EndFrame`/`StopFrame`/`CancelFrame` for teardown (`frames.py:1581-1620,865`).

`AudioRawFrame.num_frames` is derived as `len(audio)/(num_channels*2)` — assuming 16-bit PCM (`frames.py:166-167`), the canonical wire format.

**Prior-art divergence.** Modal lists "audio/text/video frames" generically (`modal-one-second-voice-to-voice.md:16`); Pipecat is the only clone that exposes a 100+ type taxonomy. LiveKit instead carries semantics in Python objects/events (see [[ARCH-04-event-driven-lifecycle]]) rather than a frame class hierarchy. Cloudflare's voice mixin uses plain JSON protocol messages (`transcript`, `status`, `playback_interrupt`) over WebSocket, not frame types (`cloudflare-agents/packages/voice/src/voice.ts:586-595`).

**Implication for Syrinx.** Whether or not we adopt a literal frame class tree, the *categories* (system/data/control + the lifecycle set) are the minimal vocabulary; partials vs finals must be distinct types so downstream stages can choose to ignore partials (cf. Modal: only final-transcript time matters for v2v).

Links: [[ARCH-01-frame-pipeline-model]] [[ARCH-03-system-vs-data-frame-ordering]] [[ARCH-04-event-driven-lifecycle]] [[XPORT-02-canonical-pcm-sample-rates]] [[STT-02-partial-final-lifecycle]]
