# WT-07 / G19 — `ClientTransport` seam + Opus on the browser leg

- **Status:** In Review · **Priority:** P2 · **Phase:** 2 (scale seam)
- **Area:** transport / scale · **Findings:** F8 (bandwidth), F11 (transport seam)
- **Depends on:** WT-05, WT-02 · **Blocks:** —
- **Catalog:** G19

## Problem / Evidence

- **F8 — raw PCM uplink.** The browser client sends 16 kHz PCM16 envelopes
  (`voice-client-browser/src/index.ts:225` `encodeBrowserPcmEnvelope`) ≈ **256
  kbps** per session. Kwindla §4.5.4: *"Avoid sending raw 16-bit PCM over the
  internet… too heavy for many real-world uplinks."* 8× an Opus stream; brutal at
  scale and on mobile.
- **F11 — no transport seam.** WebSocket is hard-wired on the browser leg. Every
  source flags this leg as where WebSocket is weakest (HoL blocking, no Opus
  pacing/FEC, no AEC). A future WebRTC last-mile or QUIC/WebTransport path requires
  a seam, or it's an app rewrite. Cloudflare ships exactly such a seam
  (`VoiceTransport`).

## Root cause (diagnose)

The client was built directly on the browser `WebSocket` with raw PCM framing; no
abstraction sits between the app and the wire.

## Proposed solution (rfc) — build the seam, add Opus behind it; do NOT build WebRTC now

1. **`ClientTransport` interface** (mirror Cloudflare `VoiceTransport`):
   `connect/disconnect/connected/sendAudio/sendJSON/onAudio/onMessage`.
   `WebSocketClientTransport` is impl #1; `SyrinxBrowserClient` consumes the
   interface. This makes a later `WebRtcClientTransport` / `WebTransportTransport`
   a swap, not a rewrite. (Server-side: define the symmetric seam so the host can
   accept an alternate ingress later.)
2. **Opus on the browser leg**, behind the seam and negotiated in `ready`:
   encode mic PCM → Opus (dynamic-import the codec, as SmartPBX already does with
   `@evan/opus`) for uplink; decode Opus downlink. Keep PCM as a fallback for
   clients that can't Opus. Server advertises supported input codecs in `ready`
   and decodes Opus ingress to engine PCM16.

> Seam + Opus ship here. WebRTC/QUIC impls are future *config behind the seam*,
> explicitly not part of this issue — but the seam makes them non-breaking.

## Acceptance criteria
- [x] `ClientTransport` interface; `WebSocketClientTransport` implements it; client uses it.
- [x] Opus uplink + downlink negotiated via `ready`; PCM fallback retained.
- [x] Measured uplink for the browser smoke drops from ~256 kbps to ~102 kbps (4× compression; wire 48 kHz Opus).
- [x] Server decodes Opus ingress → engine PCM16 (reuse WT-02 audio module + opus).

## Test plan (TDD + smoke)
- **Unit:** transport interface conformance (a fake transport drives the client);
  Opus encode→decode round-trip fidelity; `ready` codec negotiation picks Opus when
  both support it, PCM otherwise.
- **Smoke (live):** headless-Chrome browser smoke with Opus negotiated end-to-end;
  assert decoded server-side audio is coherent (Whisper) and log the uplink byte
  rate vs the PCM baseline.

## Definition of done
Swappable client transport seam + working Opus browser leg with measured bandwidth
win and coherent live decode; WebRTC/QUIC documented as future drop-ins.

## Sources
Kwindla §4.5.4 (avoid raw PCM, Opus default); Cloudflare `VoiceTransport`; F8, F11.
