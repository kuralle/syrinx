---
id: XPORT-10
title: Acoustic echo cancellation — the hardware/WebRTC defence behind open-mic barge-in
domain: XPORT
tags: [aec, echo-cancellation, echo, full-duplex, webrtc, warmup, self-speech]
sources: [deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_session.py:149, agents/livekit-agents/livekit/agents/voice/agent_session.py:240, agents/livekit-agents/livekit/agents/voice/agent_session.py:308, agents/livekit-agents/livekit/agents/voice/agent_session.py:420, agents/livekit-agents/livekit/agents/voice/agent_session.py:1553, agents/livekit-agents/livekit/agents/cli/cli.py:308, agents/livekit-agents/livekit/agents/voice/audio_recognition.py:194]
---

**Claim (one line):** Acoustic echo cancellation (AEC) is the WebRTC-level defence that subtracts the agent's own playback from the mic input so the pipeline doesn't hear itself; it requires a calibration warmup, and during that window the system must either suppress interrupts or risk self-interruption from residual echo.

**Detail.** Deepgram lists "Echo or Audio Feedback Loops" as a common failure mode: it originates in "audio routing configuration or lack of echo cancellation" and the fix is to verify "full-duplex configuration and hardware echo cancellation settings" (deepgram-ebook ~2071–2079). The core mechanism: AEC subtracts the known playback waveform from the mic stream, using an adaptive filter that converges on the acoustic path between speaker and microphone.

LiveKit Python's `AgentSession` exposes AEC as a first-class concern via `aec_warmup_duration` (`agent_session.py:149,240`). On construction it defaults to `3.0` seconds (`agent_session.py:240`), and the docstring explicitly states: "The duration in seconds that the agent will ignore user's audio interruptions after the agent starts speaking. This is useful to prevent the agent from being interrupted by echo before AEC is ready" (`agent_session.py:308-310`). Internally the session tracks `_aec_warmup_remaining` (`:421`) and starts a timer on the first agent speech (`:1553-1559`) that calls `_on_aec_warmup_expired` (`:1510-1517`) to re-enable interruptions after the warmup period elapses. The CLI console tool enables WebRTC AEC explicitly via `echo_cancellation=True` on its `rtc.AudioProcessingModule` for local console audio I/O (`cli.py:308`).

LiveKit's complementary defence is the `_ignore_user_transcript_until` window in `AudioRecognition` (`audio_recognition.py:194`): on agent speech end, transcripts arriving from audio that was captured while the agent was still playing are held back (not forwarded to the LLM), preventing self-echo from being treated as user input. This `ignore_user_transcript_until` timestamp is set at `on_end_of_agent_speech` (`:311-344`) and governs the `_should_hold_stt_event` gating logic (`:504`). Together with `backchannel_boundary` cooldowns at turn start/end, this creates a layered defence: AEC at the acoustic layer, ignore-window at the transcript layer, and confidence gating ([[BARGE-06-confidence-gated-interruption]]) at the interruption layer.

**Prior-art divergence.** LiveKit layers AEC warmup + transcript ignore windows to keep the mic open (enabling barge-in). Pipecat uses a **hard mute** during agent speech via `AlwaysUserMuteStrategy` (`always_user_mute_strategy.py:14`) — simplest but destroys barge-in. Deepgram's Rust reference agent also hard-mutes (ebook ~1546). Telephony sidesteps AEC entirely: the media gateway isolates inbound/outbound channels, making echo cancellation the carrier's problem (ebook ~2076). The key trade: AEC enables true full-duplex barge-in but needs 3 s warmup + ongoing filter adaptation; hard mute guarantees no self-interruption but kills barge-in.

**Implication for Syrinx.** For WebRTC/browser paths, depend on the WebRTC stack's built-in AEC (aiortc/browser), gate interruptions behind a configurable `aec_warmup_duration`, and use `ignore_user_transcript_until` as a transcript-level backstop. For telephony, rely on the carrier's channel isolation. Never hard-mute if barge-in is required.

Links: [[BARGE-07-echo-auto-mute]] [[BARGE-01-full-duplex-requirement]] [[BARGE-06-confidence-gated-interruption]] [[XPORT-01-ws-vs-webrtc]] [[XPORT-09-opus-webrtc-codec]]
