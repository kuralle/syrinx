---
title: Codecs, DTMF & transfer
description: Wideband codecs, sending touch-tones, and transferring a call.
---

Beyond streaming audio, a phone agent often needs to navigate an IVR, key in digits, or hand the caller off. Syrinx exposes these as bus packets that map to each carrier's control API.

## Codecs

Syrinx transcodes narrowband and wideband telephony codecs to and from your pipeline's PCM16:

| Codec | Rate | Carrier |
|---|---|---|
| μ-law (PCMU) | 8 kHz | Twilio, Telnyx, SmartPBX |
| A-law (PCMA) | 8 kHz | Telnyx |
| G.722 | 16 kHz | Telnyx |
| L16 | 16 kHz | Telnyx |

G.722 is the one worth reaching for: it's wideband, so your STT sees the full speech band instead of the narrowband μ-law cut. Syrinx keeps it at 16 kHz all the way to the transcriber. The codecs are pure and run identically on Node and the Cloudflare Workers edge.

:::caution[Preview]
The A-law and G.722 codecs are implemented and unit-tested, but codec negotiation on a live carrier trunk is not yet certified. G.722 is spec-implemented and round-trip tested.
:::

## Sending DTMF

Send touch-tones — to navigate an IVR you called into, for example — with a `dtmf.send` packet. Digits are `0-9`, `*`, `#`, plus pause markers `w` (0.5 s) and `W` (1 s):

```ts
import { Route, dtmfSend } from '@kuralle-syrinx/core';

bus.push(Route.Main, dtmfSend(contextId, Date.now(), '1w234#'));
```

Syrinx builds the carrier command for you — Twilio's `<Play digits>` (or the Calls API `sendDigits`), or Telnyx Call Control `send_dtmf`. Inbound DTMF arrives as `dtmf.received`.

## Transferring a call

Hand the caller off with a `call.transfer` packet:

```ts
import { Route, callTransfer } from '@kuralle-syrinx/core';

bus.push(Route.Main, callTransfer(
  contextId,
  Date.now(),
  'warm',
  '+15551234567',
  'Caller wants a refund on order 4821; verified identity.',
));
```

| Mode | Behavior |
|---|---|
| `warm` | Announce the caller (with the optional `summary`, generated from the conversation) before connecting |
| `cold` | Connect immediately |
| `sip_refer` | SIP REFER |

Syrinx prefers a carrier Call Control transfer over SIP REFER where answer rates matter (REFER can lower STIR/SHAKEN attestation).

:::caution[Preview]
DTMF-send and call transfer build the correct carrier command payloads and are unit-tested, but sending to a live IVR and bridging a live transfer are not yet certified against a real carrier.
:::
