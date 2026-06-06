# WebRTC / Opus-FEC decision (VE-08.7)

**Decision: stay on WebSocket + Opus; do NOT enable Opus in-band FEC; defer full WebRTC.** Documented here per the VE-08.7 acceptance ("WebRTC/FEC item is either implemented or explicitly deferred if Syrinx keeps WebSocket+Opus").

## Why Opus in-band FEC is NOT enabled

Opus in-band FEC (and RED) recover **lost packets** by carrying redundant data for the previous frame, so a decoder can reconstruct a dropped packet. They are designed for **lossy datagram transports** — UDP/RTP, i.e. WebRTC.

**Every Syrinx media transport runs over a WebSocket, which is TCP:**
- Browser client → `/ws` (TCP WebSocket, `syrinx.audio.v1` Opus/PCM envelopes).
- Twilio / Telnyx / SmartPBX → carrier media-stream **WebSockets** (TCP).

TCP guarantees reliable, in-order delivery. There is **no application-layer packet loss** to recover: network loss is handled by TCP retransmission, which surfaces as *latency/jitter*, not lost audio. That jitter is absorbed by the client `AudioJitterBuffer` (100 ms pre-roll) and the server paced playout.

Therefore enabling `encoder.inband_fec` / `packet_loss` on the Opus encoder over TCP would **add bitrate overhead for zero recoverable-loss benefit** — it only helps on a lossy datagram path. We deliberately leave it off.

## Why full WebRTC is deferred

Native WebRTC (ICE + DTLS + SRTP over UDP) is the transport where Opus FEC/RED *does* pay off, and it can beat a TCP jitter buffer for tail latency on bad networks (no head-of-line blocking). But it adds material complexity: ICE/NAT traversal + TURN relays, DTLS handshakes, SRTP keying, and bundle/transport-policy ops — for a benefit that only materializes on genuinely lossy/jittery last-mile networks.

For the current targets — good-network browsers and carrier-managed telephony (the carrier already runs its own jitter/loss handling to the PSTN) — **WebSocket + Opus over TCP is sufficient and simpler.** The browser client keeps a transport seam (`voice-client-browser` `transport`, default WebSocket) so WebRTC/WebTransport can be added later without touching the engine.

## Revisit criteria

Move to WebRTC (and turn on Opus FEC there) only if a real deployment shows **measured packet loss / jitter that TCP retransmit + the 100 ms jitter buffer cannot absorb** — e.g. v2v tail (P99) regressions correlated with lossy mobile/last-mile networks. Until then, this is a deliberate, documented non-goal, not an oversight.

## Status of related VE-08.7 surface
- Opus encoder: `packages/server-websocket/src/browser-opus.ts` (`application: "voip"`, no FEC — intentional per above).
- Media-mode statement: `docs/websocket-audio-protocol.md` → "Client Media Mode (current)".
