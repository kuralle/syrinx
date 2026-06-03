---
id: BARGE-01
title: Full-duplex is the precondition for barge-in
domain: BARGE
tags: [full-duplex, concurrency, transport, echo]
sources: [deepgram-ebook, together-talk]
code_refs: [agents/livekit-agents/livekit/agents/voice/audio_recognition.py:152]
---

**Claim (one line):** Barge-in is impossible unless input and output audio pipelines run concurrently — the mic must keep being read *while* the agent is speaking.

**Detail.** Deepgram is explicit: "Input and output pipelines must run concurrently. When new speech is detected during playback, output should stop immediately" (deepgram-ebook ~line 572-573). Phone agents "must send and receive audio concurrently. Blocking pipelines introduce dead air, clipped speech, or missed interruptions" — the canonical pattern is two independent async loops, `receive_media` and `send_media`, each draining its own queue (deepgram-ebook ~line 737-748). Their failure-mode catalog confirms the inverse: "Agent Talks Over the User or Misses Interruptions" originates in audio transport — "whether audio is flowing continuously during agent playback and whether the system supports true full-duplex streaming. Reliable barge-in depends on uninterrupted microphone input" (deepgram-ebook ~line 2043-2049). Together-AI frames S2S models as "natively better at interruptions/barge-in" precisely because they are full-duplex — "produce audio while receiving" — whereas the cascading pipeline "needs complex engineering for this" (together-talk line 38). In code, LiveKit runs STT/VAD recognition on a continuously-fed audio input task (`_audio_input_atask`, `audio_recognition.py:152`) that is never paused for agent playback.

**Prior-art divergence.** S2S (OpenAI Realtime, NVIDIA) gets full-duplex "for free" from the model; the cascading pipeline (Pipecat/LiveKit/Vapi/Deepgram) must engineer it as two concurrent transport loops plus echo suppression. The cost of full-duplex is that the mic now hears the agent — see [[BARGE-07-echo-auto-mute]].

**Implication for Syrinx.** Our WS/WebRTC transport must read inbound frames on a task that is independent of TTS egress; never block the receive loop on playback. This is the structural prerequisite before any of the [[BARGE-02-interruption-sequence]] work matters.

Links: [[BARGE-02-interruption-sequence]] [[BARGE-07-echo-auto-mute]] [[XPORT-02-canonical-pcm-sample-rates]]
