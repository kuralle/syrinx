---
id: XPORT-07
title: Twilio Media Streams wire serialization (JSON envelope + base64 µ-law)
domain: XPORT
tags: [twilio, serialization, media-streams, streamSid, barge-in]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/serializers/twilio.py:129, pipecat/src/pipecat/serializers/twilio.py:238, cloudflare-agents/voice-providers/twilio/src/index.ts:148, pipecat/src/pipecat/serializers/twilio.py:149]
---

**Claim (one line):** Twilio Media Streams is a JSON-over-WebSocket protocol where each audio packet is `{"event":"media","streamSid":...,"media":{"payload":<base64 µ-law>}}`, and the `streamSid` must be echoed on every outbound message to avoid cross-call contamination.

**Detail.** Inbound deserialization (`twilio.py:238`): parse JSON, on `event=="media"` base64-decode `media.payload`, `ulaw_to_pcm(payload, 8000, pipeline_rate)` → `InputAudioRawFrame`; on `event=="dtmf"` emit an `InputDTMFFrame(KeypadEntry(digit))`. Outbound serialization (`twilio.py:129`): an `AudioRawFrame` becomes `pcm_to_ulaw → base64 → {"event":"media","streamSid":self._stream_sid,"media":{"payload":...}}`. The stream identity is mandatory on every message — Deepgram: "Each session is identified by a unique call or stream identifier, which must be preserved on all inbound and outbound media to avoid cross-call contamination" (ebook line 709–711); the serializer is constructed with `stream_sid` and stamps it everywhere. **Barge-in is a protocol message:** on `InterruptionFrame` the serializer emits `{"event":"clear","streamSid":...}` (`twilio.py:149–151`) telling Twilio to flush its outbound media buffer immediately — without `clear`, already-sent-but-unplayed audio keeps playing after the user interrupts. DTMF is handled "outside the speech pipeline so they do not pollute transcripts" (ebook line 755). On `EndFrame`/`CancelFrame` the serializer optionally hits Twilio's REST API to set call `Status=completed` (auto-hangup, `twilio.py:142`).

**Prior-art divergence.** Cloudflare's Twilio adapter implements the same envelope (`TwilioMediaMessage`, `index.ts:148`) but uses **`event:"mark"`** to correlate agent JSON events back to the Twilio side (`index.ts:255–266`) and converts the agent's **MP3** TTS to µ-law (`index.ts:12`), whereas Pipecat assumes PCM TTS frames. Pipecat exposes the `clear` barge-in event explicitly; Cloudflare's adapter (in this excerpt) relies on marks for correlation. Telnyx/Plivo/Genesys/Exotel serializers mirror the structure with provider-specific event names and (for Exotel) raw PCM instead of µ-law (see [[XPORT-04-mulaw-telephony-path]]).

**Implication for Syrinx.** Our Twilio serializer must (1) stamp `streamSid` on every outbound packet, (2) emit `clear` on interruption to stop buffered playback, (3) route DTMF out-of-band. These are correctness requirements, not optimizations.

Links: [[XPORT-04-mulaw-telephony-path]] [[XPORT-01-ws-vs-webrtc]] [[BARGE-02-interruption-sequence]] [[REL-04-state-restoration-injected]]
