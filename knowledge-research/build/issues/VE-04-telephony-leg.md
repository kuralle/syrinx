# VE-04 — Telephony leg (PSTN/SIP via carrier)

**Type:** AFK · **Tier:** Tier-0 · **Status:** Backlog
**Master document:** [`../../PRODUCTION-CHECKLIST.md`](../../PRODUCTION-CHECKLIST.md) → **§1 (telephony items)**, **§9 (DTMF)**

## What to build
The same engine reachable over a phone call: carrier WebSocket bridge, 8 kHz µ-law media, DTMF handled out-of-band.

## Acceptance criteria
- [ ] Provider-specific telephony serializer (Twilio/Telnyx style) with carrier **stream identity on every outbound message**, µ-law conversion, and `clear`-on-interrupt before next response audio.
- [ ] 8 kHz mono µ-law/A-law isolated to the telephony edge; prefer native µ-law I/O where the STT/TTS provider supports it (avoid transcoding) — otherwise resample/encode at the serializer boundary with a stateful resampler.
- [ ] DTMF detected/handled **outside** STT as a typed control event (digits 0–9, *, #); never fed as STT audio, never triggers barge-in.
- [ ] Application keepalive + output silence on idle so carrier sockets aren't reaped/underrun.

## Demo / verify
Place a real call → full conversation works over PSTN; press a keypad digit → routed as a control event without polluting the transcript.

## Blocked by
VE-01 (and VE-03 for clear-on-interrupt).

## Key references
notes: XPORT-04/07/08/11, TTS-06; wiki/xport-map.
