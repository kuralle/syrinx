# Sprint 01 — WebSocket Transport Hardening + Voice-Engine Scale

Grounded in a thermo-nuclear code-quality review of `voice-server-websocket` /
`voice-ws` / `voice-client-browser`, cross-checked against the Deepgram Voice
Agent guide (`research-notes/deepgram-voice-agent.txt`), the LiveKit / Cloudflare
/ Level-Up / dev.to / Deepgram transport articles, Kwindla Hultman Kramer's
Pipecat voice-agents gist + talk, and 2025–26 research papers (see each issue's
**Sources**). Full review trail in the conversation handoff and
`VOICE-ENGINE-HARDENING.md`.

## Operating contract for every issue in this sprint

> Take an autonomous stand, and deliver the work. Do not ask for permissions, do
> not ask questions (take all the well-researched recommendations into account).
> You have the right tools to find your answers. Fend for yourself and deliver
> results. Do the whole thing. Do it right. Do it with tests. Do it with
> documentation. Do it so well that the reviewer is genuinely impressed — not
> politely satisfied, actually impressed.
>
> **NO shortcuts, NO deferring, NO "I'll do this for later."** If something needs
> time, take the time. Never stop early for token-budget reasons. Never present a
> workaround when the real fix exists. Embrace breaking changes over back-compat
> for the best outcome. Don't fight errors — research 3–5 fixes, pick the most
> efficient, implement it, and record the decision in `implementation-notes.md`.
> Search before building. Test before shipping. Ship the complete thing. The
> standard isn't "good enough" — it's "holy shit, that's done."

Every issue ships with: TDD (failing test → fix → green), **live-API smoke**
where a provider/transport boundary is touched, documentation, and a regression
assertion. "Done" means observed working end-to-end, not type-check-green.

## Issue index

| ID | Catalog | Title | Phase | Pri | Status |
|---|---|---|---|---|---|
| [WT-01](WT-01-transport-host.md) | G13 | Extract `WebSocketTransportHost` (collapse 4 transports → 1) | 0 | P1 | Ready |
| [WT-02](WT-02-canonical-audio.md) | G14 | Canonical audio module + anti-aliased resampler | 0 | P1 | Ready |
| [WT-03](WT-03-browser-pacing.md) | G15 | Browser outbound pacing + playout clock + client jitter buffer | 1 | P1 | Blocked |
| [WT-04](WT-04-graceful-drain.md) | G16 | Graceful connection draining on shutdown | 1 | P1 | Blocked |
| [WT-05](WT-05-client-reconnect.md) | G17 | Browser client reconnect + resume + keepalive | 1 | P1 | Ready |
| [WT-06](WT-06-session-store.md) | G18 | Externalizable `SessionStore` interface | 2 | P2 | Blocked |
| [WT-07](WT-07-client-transport-opus.md) | G19 | `ClientTransport` seam + Opus on the browser leg | 2 | P2 | Blocked |
| [WT-08](WT-08-concurrency-admission.md) | G20 | Concurrency cap + admission control + upgrade-path leak | 2 | P2 | Blocked |
| [WT-09](WT-09-observability.md) | G21 | Metrics wiring + per-turn timestamps + browser loss/jitter smoke | 2 | P2 | Blocked |
| [VE-01](VE-01-semantic-endpointing.md) | G22 | Semantic endpointing fused off the STT encoder | E | P2 | Ready |
| [VE-02](VE-02-speaker-barge-in.md) | G23 | Speaker-attribution barge-in gate | E | P2 | Ready |
| [VE-03](VE-03-latency-filler.md) | G24 | Latency-hiding filler token (dual-track) | E | P3 | Ready |
| [VE-04](VE-04-spoken-prefix-context.md) | G25 | Word-level-timestamp context alignment (completes G2) | E | P1 | Ready |
| [VE-05](VE-05-eval-gate.md) | G26 | EVA-Bench / Full-Duplex-Bench CI gate | E | P3 | Ready |

Phases: **0** = foundation (everything depends on it) · **1** = correctness/scale
bugs riding the host · **2** = scale seams (interfaces now, heavy impls behind
them) · **E** = engine track (independent, parallelizable).

## Execution waves (dependency-ordered — not deferral; every issue is specced now)

- **Wave 0:** WT-02, WT-05, VE-04 (non-conflicting: `voice` audio, `voice-client-browser`, `voice` context).
- **Wave 1:** WT-01 (needs WT-02), VE-01, VE-02.
- **Wave 2:** WT-03, WT-04, WT-08 (need WT-01), VE-03.
- **Wave 3:** WT-06, WT-07, WT-09, VE-05.

See [KANBAN.md](KANBAN.md) for live status.
