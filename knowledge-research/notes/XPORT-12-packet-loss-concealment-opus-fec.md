---
id: XPORT-12
title: Packet loss concealment — Opus FEC and jitter-buffer PLC under WebRTC loss
domain: XPORT
tags: [packet-loss, fec, plc, opus, webrtc, jitter, concealment, reliability]
sources: [deepgram-ebook, modal-v2v]
code_refs: []
---

**Claim (one line):** Opus FEC (forward error correction) embeds redundant low-bitrate copies of prior frames in each packet, enabling the jitter buffer to conceal isolated loss without stutter — this is largely a WebRTC-stack concern, and most voice-engine clones leave it to the media engine rather than configuring it in application code (Rapida is the exception: it sets `useinbandfec=1` in app code).

**Detail.** Opus supports **in-band FEC**: each packet can carry a low-bitrate encoding of the previous frame alongside the current frame. When the jitter buffer detects a missing packet, it uses the FEC data in the *next* received packet to synthesize the lost frame, avoiding the classic audio artifact of a dropped frame. Opus also supports **DTX** (discontinuous transmission) for silence suppression, which Pipecat's Vonage transport exposes as `publisher_enable_opus_dtx` (`vonage/client.py:84-95`). On the receive side, WebRTC jitter buffers implement **PLC** (packet loss concealment) — waveform interpolation or silence fill when FEC is unavailable or the loss exceeds one frame.

Deepgram lists "Choppy, Distorted, or Unnatural Audio" as a failure mode originating in "playback buffering, encoding mismatches, or network instability" (ebook ~2060-2062). **Most OSS voice-engine clones do not explicitly configure Opus FEC parameters.** Pipecat's `SmallWebRTCTransport` uses aiortc's `RTCPeerConnection` defaults and never sets `useinbandfec` on audio codec preferences — it creates an `RTCPeerConnection(rtc_config)` (`connection.py:315`) without custom codec parameters. LiveKit's `AudioStreamDecoder` (`decoder.py:336ff`) decodes Opus→PCM but never inspects or sets FEC flags. Rapida is the exception: it implements an application-level WebRTC transport (`channel/webrtc/streamer.go`) and explicitly enables Opus in-band FEC, setting `useinbandfec=1` in its `OpusSDPFmtpLine` (`channel/webrtc/internal/types.go:16`) and feeding it into the registered Opus codec capability (`streamer.go:174`). Cloudflare's SFU delegates codec negotiation to the browser. For the clones that don't configure it, the absence of application-level FEC is intentional: Opus FEC and jitter-buffer PLC operate at the **media engine layer** (aiortc/libwebrtc/browser), below the voice-pipeline's visibility. The pipeline sees only the decoded PCM output.

**Prior-art divergence.** Rapida diverges: it explicitly enables Opus in-band FEC at the application level (`useinbandfec=1` in `OpusSDPFmtpLine`, `channel/webrtc/internal/types.go:16`, applied at `streamer.go:174`). Pipecat, LiveKit, and Cloudflare's SFU instead delegate packet loss concealment to the underlying WebRTC/media engine and never expose FEC knobs. Pipecat's DTX exposure (`enable_opus_dtx`) is its only codec-level flag, and it's for silence suppression, not loss resilience.

**Implication for Syrinx.** Opus FEC is a deployment/WebRTC-configuration concern, not an application-code concern. Verify that the chosen WebRTC stack (aiortc or browser) enables Opus FEC by default (aiortc does; browsers do). For WebSocket transport (telephony), there is no FEC — packet loss manifests as a gap, so prioritize low-jitter network paths and keep the jitter buffer ([[XPORT-06-jitter-buffer-playback]]) sized for concealment. **(Unverified: exact aiortc FEC defaults — the aiortc source is outside our clone set.)**

Links: [[XPORT-06-jitter-buffer-playback]] [[XPORT-09-opus-webrtc-codec]] [[XPORT-01-ws-vs-webrtc]] [[REL-10-failure-mode-catalog]]
