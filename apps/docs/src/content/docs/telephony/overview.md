---
title: Telephony
description: Twilio, Telnyx, and SmartPBX carriers; codecs, DTMF, and call transfer.
---

Syrinx terminates PSTN media-stream WebSockets from carriers and hands the engine mono PCM16, transcoding per the negotiated codec.

:::caution[Unit-verified only]
The telephony **codecs, DTMF-send, and call transfer** below are **unit-verified** in this build. There are **no live carrier credentials** — treat green tests as protocol-correctness, not carrier certification. Specifically unverified against a live carrier: real IVR DTMF decode, trunk G.722/PCMA negotiation, and a live transfer bridge.
:::

## Carriers

- **Twilio** Media Streams — μ-law 8 kHz. Node (`server-websocket/twilio.ts`) and the Workers edge (`edge-twilio.ts`, `/twilio`).
- **Telnyx** Media Streaming — PCMU / **PCMA** / **G.722** / L16. Node (`server-websocket/telnyx.ts`) and the Workers edge (`edge-telnyx.ts`, `/telnyx`).
- **SmartPBX** — inbound DTMF, μ-law.

## Codecs

μ-law (PCMU) and L16 were always supported. Added: **PCMA** (ITU-T G.711 A-law, known-answer tested) and **G.722** (stateful sub-band ADPCM — *spec-implemented, round-trip-tested, not ITU-vector-certified*). G.722 stays at 16 kHz to STT (no downsample pitfall). The codecs live in `@kuralle-syrinx/core/audio` (pure TypedArray, Workers-safe) and are shared between the Node host and the Workers runner via `telnyx-codec.ts`.

## DTMF-send & call transfer

- `dtmf.send` packet (digits `[0-9*#wW]`, pause `w`/`W`) → per-carrier command: Twilio `<Play digits>` TwiML, Telnyx Call-Control `send_dtmf`.
- `call.transfer` packet (`warm` / `cold` / `sip_refer`) → Call-Control transfer (preferred over SIP REFER for STIR/SHAKEN attestation), with a warm-handoff summary seam.

Dispatch to the carrier Call-Control API uses global `fetch()` with **injected** credentials (no `process.env`), so it runs on Node and Cloudflare Workers.

## On Cloudflare Workers

Telnyx (and its G.722/PCMA) runs on the Workers edge via a `TelnyxVoiceConversation` Durable Object and the `/telnyx` route. This path is **unverified against a live carrier or a live Workers deploy**. See [Deploy on Cloudflare](/guides/deploy-on-cloudflare/).
