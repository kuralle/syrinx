# VE-01 — End-to-end audio round-trip (tracer bullet)

**Type:** AFK · **Tier:** Tier-0 · **Status:** Backlog
**Master document:** [`../../PRODUCTION-CHECKLIST.md`](../../PRODUCTION-CHECKLIST.md) → **§1 Audio Transport**, **§2 STT Ingestion**, **§5 TTS Egress** (core items only)

## What to build
The thinnest complete path through the engine: client audio in → streaming STT → final transcript → a trivial responder (echo or one-line LLM) → streaming TTS → audio back to the client. Proves the whole pipe is wired and demoable before any capability layers.

## Acceptance criteria
- [ ] Client audio carried over WebRTC (browser) and/or WebSocket (server/provider), int16 mono PCM internally, with explicit sample-rate/encoding handshakes on each STT/TTS socket (declared == actual).
- [ ] Stateful edge resampling between link rate and pipeline rate (16 kHz STT ingress, 24 kHz TTS egress defaults).
- [ ] Persistent streaming STT socket reused across turns; emits a single authoritative final transcript per utterance.
- [ ] Streaming TTS (not whole-utterance); first audio chunk measured (TTFA/TTFB) and streamed back with small fixed output frames (10–50 ms, target 20 ms).
- [ ] Bounded playout jitter buffer on the output side (design band 100–200 ms).

## Demo / verify
Speak into the client → hear a reply within the v2v budget. Capture a v2v latency number end-to-end.

## Blocked by
VE-00 (gap analysis re-scopes this).

## Key references
notes: XPORT-01..06, STT-01/02/04/10, TTS-01/02/03/05; wiki/xport-map, stt-map, tts-map.

## Current state (Syrinx)
Pipeline spine exists (WS/browser/telephony ingress -> session fan-out -> streaming STT -> LLM bridge -> streaming TTS -> paced playout), but VE-01 must close audio-format assertions, interactive playout bounds, and live non-empty baseline proof. See [`../reconcile/VE-01-bridge.md`](../reconcile/VE-01-bridge.md).
