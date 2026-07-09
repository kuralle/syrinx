# Syrinx documentation

## Guides

- **[Building a voice agent](guides/building-a-voice-agent.md)** — kuralle-agents + Syrinx: primitives, bridges, Node and Cloudflare.

## Reference

- [**Testing & baseline runbook**](testing-runbook.md) — verify command, CI, the smoke catalog, latency gates, and how to establish a baseline.
- [WebSocket audio protocol](websocket-audio-protocol.md)
- [Reasoner bridge](reasoner-bridge.md)
- [Latency budget](latency-budget.md)

## vNext RFCs (2026-07 roadmap — building on `beta`)

> The vNext RFCs were drafted from a 2026-07-02 snapshot; several premises are stale. **Read each RFC's amendment first** — it records what was actually built + the test/baseline runbook.

- [RFC: Incremental-Unit substrate](rfc-incremental-unit-substrate.md) — the IuLedger. ✅ built ([amendment](rfc-incremental-unit-substrate-amendment-C5.md): C5→backlog, C4 net-harmful→skip).
- [RFC: Reasoner-latency (routing + hedging)](rfc-reasoner-latency.md) — RoutingReasoner + HedgedReasoner. ✅ built + live-gated ([**amendment + test/baseline runbook**](rfc-reasoner-latency-amendment.md)).
- [RFC: InteractionPolicy seam + VAP](rfc-interaction-policy-seam.md) — full-duplex turn-taking (next up).
- [RFC: Half-cascade (text-only front + Syrinx TTS)](rfc-half-cascade.md) — blocked on InteractionPolicy.

## RFCs and implementation notes

- [RFC: reasoner bridge](rfc-reasoner-bridge.md)
- [RFC: realtime bridge](rfc-realtime-bridge.md)
- [RFC: bi-model delegate seam](rfc-bimodel-delegate-seam.md)
- [RFC: WebSocket transport hardening](rfc-ws-transport-hardening.md)
- [RFC: Cloudflare first-party deployment](rfc-cloudflare-first-party-deployment.md)
- [Serverless edge port notes](serverless-edge-port-implementation-notes.md)
