---
id: BARGE-07
title: Auto-mute the mic during playback to avoid self-interruption
domain: BARGE
tags: [echo, feedback, auto-mute, aec, self-interruption]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/turns/user_mute/always_user_mute_strategy.py:14, agents/livekit-agents/livekit/agents/voice/audio_recognition.py:311]
---

**Claim (one line):** Full-duplex means the open mic hears the agent's own TTS; without echo cancellation or mic muting the agent interrupts itself and transcribes its own voice.

**Detail.** Deepgram lists "Echo or Audio Feedback Loops" as a named failure mode: it "usually originates in audio routing configuration or lack of echo cancellation"; inspect "whether agent output is being fed back into the input stream, full-duplex configuration, and hardware echo cancellation settings… Agent hearing itself can trigger response loops or distorted transcription" (deepgram-ebook ~line 2071-2079). Their Rust reference agent solves it the blunt way: "automatic microphone muting during playback to prevent feedback and support natural turn-taking" (deepgram-ebook ~line 1546, 1559-1561). Pipecat offers this as a pluggable strategy: `AlwaysUserMuteStrategy` returns muted whenever `_bot_speaking` is True (`always_user_mute_strategy.py:14-37`), alongside `MuteUntilFirstBotComplete`, `FirstSpeech`, and `FunctionCall` variants. LiveKit's softer approach keeps the mic open (needed for barge-in) but suppresses *false* triggers during the agent's own speech via `on_end_of_agent_speech(ignore_user_transcript_until=...)` and `backchannel_boundary` cooldowns at turn start (`audio_recognition.py:295-321`).

**Prior-art divergence.** Hard mute (Deepgram Rust, Pipecat `AlwaysUserMute`) is simplest but *destroys barge-in* — a muted mic can't hear an interruption. LiveKit deliberately does NOT mute (mic stays open) and instead relies on AEC + ignore-windows + the confidence gate ([[BARGE-06-confidence-gated-interruption]]) so real barge-in survives while self-echo is filtered. Telephony sidesteps it: the media gateway isolates inbound/outbound channels (deepgram-ebook ~line 2076-2077).

**Implication for Syrinx.** Hard mic-mute and barge-in are in tension. For a true barge-in agent, keep the mic open and lean on acoustic echo cancellation + a self-speech ignore window rather than muting. Reserve hard mute for half-duplex / push-to-talk modes only.

Links: [[BARGE-01-full-duplex-requirement]] [[BARGE-06-confidence-gated-interruption]] [[XPORT-10-acoustic-echo-cancellation]] [[REL-10-failure-mode-catalog]]
