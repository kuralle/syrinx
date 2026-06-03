---
id: XPORT-04
title: µ-law telephony path and avoiding transcoding
domain: XPORT
tags: [mulaw, alaw, telephony, 8khz, transcoding]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/audio/utils.py:170, pipecat/src/pipecat/serializers/telnyx.py:60, cloudflare-agents/voice-providers/twilio/src/index.ts:40, pipecat/src/pipecat/serializers/exotel.py:49]
---

**Claim (one line):** Telephony audio is 8 kHz mono µ-law (G.711); the latency win is to keep audio µ-law end-to-end where the STT/TTS provider speaks it natively, eliminating the resample+transcode round trip.

**Detail.** PSTN/SIP audio "operates at 8 kHz, mono, using µ-law or A-law PCM" and "the most important optimization is format alignment. Avoid transcoding wherever possible. Deepgram's speech models accept µ-law PCM natively, and its TTS can emit µ-law audio directly consumable by telephony gateways" (deepgram-ebook line 716–722). µ-law is a logarithmic 8-bit companding of 16-bit linear PCM — 2:1 size reduction at the cost of an irreversible quantization. In code the conversion is one C call each way: `audioop.ulaw2lin(ulaw_bytes, 2)` and `audioop.lin2ulaw(in_pcm_bytes, 2)` (`audio/utils.py:185,209`); A-law via `alaw2lin`/`lin2alaw` (lines 229,253). Telnyx's serializer makes encoding configurable: **`inbound_encoding="PCMU"` / `outbound_encoding="PCMU"`** with PCMA (A-law) supported (`telnyx.py:62–63`). Cloudflare ships hand-written 256-entry `MULAW_DECODE_TABLE`/`encodeMulaw` tables (`twilio/src/index.ts:40,64`) because the Workers runtime lacks `audioop`. Deepgram warns 8 kHz "slightly increases recognition difficulty" (line 717) — the bandwidth ceiling is a hard fidelity cap, not just a transport detail.

**Prior-art divergence.** Twilio/Telnyx/Genesys/Plivo serializers all default `*_sample_rate = 8000` µ-law. **Exotel diverges: it carries raw 16-bit linear PCM, not µ-law** — `exotel.py` resamples PCM↔PCM with no companding (`exotel.py:49`, comment line 100 "Exotel outputs PCM audio"). So "telephony = µ-law" is a strong default, not a universal: the serializer must be provider-specific. Deepgram's ideal (no transcoding at all) is only reachable if your STT/TTS provider accepts/emits µ-law — Pipecat still transcodes to int16 internally because its pipeline is PCM-only.

**Implication for Syrinx.** Keep a µ-law-aware serializer per carrier; if our STT/TTS can ingest/emit µ-law, expose a passthrough mode to skip the `ulaw→pcm→ulaw` round trip on the telephony path.

Links: [[XPORT-02-canonical-pcm-sample-rates]] [[XPORT-03-resampling-ingress-egress]] [[XPORT-07-twilio-media-streams-serialization]] [[LAT-08-network-vs-engine-colocation]]
