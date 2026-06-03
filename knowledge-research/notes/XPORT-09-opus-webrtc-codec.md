---
id: XPORT-09
title: Opus over WebRTC — decode to PCM at the edge
domain: XPORT
tags: [opus, webrtc, codec, 48khz, decode]
sources: [modal-v2v, diagrams]
code_refs: [agents/livekit-agents/livekit/agents/utils/codecs/decoder.py:58, agents/livekit-agents/livekit/agents/utils/codecs/decoder.py:340, agents/livekit-agents/livekit/agents/voice/room_io/_pre_connect_audio.py:127, pipecat/src/pipecat/transports/smallwebrtc/transport.py:157]
---

**Claim (one line):** WebRTC links carry Opus (48 kHz native); the pipeline decodes Opus → int16 PCM at ingress and feeds raw PCM frames to Opus at egress, so the rest of the engine never sees the codec.

**Detail.** Opus is the WebRTC mandatory-to-implement audio codec and is what both LiveKit and Pipecat-over-aiortc actually move on the client link. LiveKit ships an `AudioStreamDecoder` that handles Opus containers — it maps `"audio/opus" → "ogg"` (`decoder.py:58`) and runs frames through a PyAV decode loop into `s16` PCM with an optional `av.AudioResampler(format="s16", ...)` (`decoder.py:443`); the public decoder defaults to **`sample_rate=48000, num_channels=1`** (`decoder.py:346`). The pre-connect path sniffs the mime type and only spins up the Opus decoder when `"audio/opus"` or `"codecs=opus"` is present, else treats bytes as raw PCM via `AudioByteStream` (`_pre_connect_audio.py:120–142`). On egress, Pipecat's WebRTC `RawAudioTrack` hands raw int16 ndarrays to aiortc as `AudioFrame.from_ndarray(..., layout="mono")` (`transport.py:157`) and lets aiortc's encoder produce Opus on the wire — the application stays PCM-only. Modal's stack uses exactly this: client↔bot WebRTC (Opus implied), bot↔services WebSocket carrying PCM (modal-v2v line 40; diagrams line 30–38).

**Prior-art divergence.** LiveKit decodes Opus explicitly in Python (`utils/codecs`), reflecting its WebRTC-native design and need to bridge browser Opus into agent PCM. Pipecat delegates Opus encode/decode to aiortc and never touches it in app code — its serializers are for *WebSocket* wire formats (Twilio µ-law), not WebRTC codecs. Telephony (µ-law, [[XPORT-04-mulaw-telephony-path]]) and WebRTC (Opus) are two different codec edges feeding the same int16 core.

**Implication for Syrinx.** Treat Opus as a WebRTC-edge concern only: decode to int16 PCM at ingress, hand PCM to the WebRTC encoder at egress, and keep the internal pipeline codec-agnostic (PCM). Don't transcode Opus↔µ-law directly — go through PCM.

Links: [[XPORT-01-ws-vs-webrtc]] [[XPORT-02-canonical-pcm-sample-rates]] [[XPORT-04-mulaw-telephony-path]] [[XPORT-03-resampling-ingress-egress]]
