---
title: Twilio
description: Connect a Twilio phone number to a Syrinx voice agent over Media Streams.
---

Syrinx terminates Twilio Media Streams directly — the μ-law 8 kHz phone audio is transcoded to PCM16 for your pipeline, and your agent's speech is transcoded back, all inside one WebSocket per call.

## Point a number at your agent

Configure your Twilio phone number's **"A call comes in"** webhook to `POST https://<your-host>/incoming-call`. Syrinx returns TwiML that bridges the PSTN leg to the `/twilio` media-stream endpoint:

```xml
<Response>
  <Connect>
    <Stream url="wss://<your-host>/twilio?sessionId=<callSid>" />
  </Connect>
</Response>
```

The Twilio `CallSid` becomes the session id, so the call's media, resume, and any recording all key off the same stable id.

## On a Node server

Mount the Twilio media-stream handler alongside your other routes; it speaks the Media Streams protocol (`connected` / `start` / `media` / `mark` / `stop`) and drives a `VoiceAgentSession` per call.

## On Cloudflare Workers

The reference Worker binds a `TwilioVoiceConversation` Durable Object to `/twilio` — see [Deploy on Cloudflare](/guides/deploy-on-cloudflare/). One hibernatable Durable Object per call, no server to run.

## Codecs

Twilio Media Streams is μ-law (PCMU) at 8 kHz in both directions. Syrinx handles the transcode; there's nothing to configure. For wideband audio (G.722) you'll want [Telnyx](/telnyx/).

See [Codecs, DTMF & transfer](/telephony/codecs-dtmf-transfer/) for sending DTMF and transferring calls.
