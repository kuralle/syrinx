---
title: Telnyx
description: Connect a Telnyx call to a Syrinx voice agent over Media Streaming, with wideband codec support.
---

Syrinx terminates Telnyx Media Streaming and transcodes per the negotiated codec — including wideband **G.722**, which keeps the top half of the speech band that narrowband μ-law throws away before it reaches your STT.

## Start a stream

Start bidirectional media from a Telnyx call to your endpoint with a Call Control `streaming_start` command (or the equivalent TeXML `<Stream>` verb):

```json
POST /v2/calls/{call_control_id}/actions/streaming_start
{
  "stream_url": "wss://<your-host>/telnyx?sessionId=<id>",
  "stream_bidirectional_mode": "rtp",
  "stream_bidirectional_codec": "G722"
}
```

The reference Worker exposes a `/telnyx-stream-start` helper that builds this payload (or the TeXML) for you.

## Codecs

Telnyx negotiates the codec at stream start via `stream_bidirectional_codec`. Syrinx accepts and transcodes:

| Codec | Rate | Notes |
|---|---|---|
| `PCMU` | 8 kHz | μ-law, the default |
| `PCMA` | 8 kHz | A-law |
| `G722` | 16 kHz | Wideband — kept at 16 kHz to your STT, no downsample |
| `L16` | 16 kHz | Linear PCM |

## On Cloudflare Workers

The reference Worker binds a `TelnyxVoiceConversation` Durable Object to `/telnyx`. The codecs are pure and run on the edge unchanged.

:::caution[Preview]
Telnyx support — including the G.722/PCMA codecs and the Workers edge route — is built and unit-tested, but not yet certified against a live carrier or a live Workers deployment. Validate on your own Telnyx number before routing production traffic.
:::

See [Codecs, DTMF & transfer](/telephony/codecs-dtmf-transfer/) for sending DTMF and transferring calls.
