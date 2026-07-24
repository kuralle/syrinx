---
title: Telephony
description: Connect Syrinx to the phone network through Twilio, Telnyx, or SmartPBX.
---

Syrinx terminates a carrier's media-stream WebSocket and hands your pipeline clean mono PCM16 — transcoding the phone codec both ways — so a voice agent you built for the browser works on a phone call with no changes to your pipeline or reasoner.

## Carriers

| Carrier | Audio | Guide |
|---|---|---|
| **Twilio** | μ-law 8 kHz (Media Streams) | [Twilio](/telephony/twilio/) |
| **Telnyx** | μ-law / A-law / **G.722 wideband** / L16 (Media Streaming) | [Telnyx](/telephony/telnyx/) |
| **SmartPBX** | μ-law, inbound DTMF | — |

Each carrier works on both a Node server and the Cloudflare Workers edge — one hibernatable Durable Object per call. See [Deploy on Cloudflare](/guides/deploy-on-cloudflare/).

## Beyond audio

A phone agent usually needs more than streaming speech:

- **[Codecs](/telephony/codecs-dtmf-transfer/)** — narrowband and wideband (G.722), so your STT sees the full speech band.
- **[Sending DTMF](/telephony/codecs-dtmf-transfer/#sending-dtmf)** — key digits into an IVR you called.
- **[Call transfer](/telephony/codecs-dtmf-transfer/#transferring-a-call)** — warm, cold, or SIP REFER, with an auto-generated handoff summary.

:::caution[Preview]
Wideband codecs (A-law, G.722), DTMF-send, call transfer, and the Telnyx-on-Workers route are built and unit-tested, but not yet certified against a live carrier. Validate on your own number before routing production traffic through them.
:::
