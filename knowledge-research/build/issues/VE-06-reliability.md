# VE-06 — Reliability (the speech path never fails silently)

**Type:** AFK · **Tier:** Tier-0 · **Status:** Backlog
**Master document:** [`../../PRODUCTION-CHECKLIST.md`](../../PRODUCTION-CHECKLIST.md) → **§7 Reliability**

## What to build
Long-lived streaming legs survive transient failure, degrade gracefully, and never strand a caller in silence.

## Acceptance criteria
- [ ] Reconnect provider/control WebSockets with bounded backoff (floor ~4 s / cap ~10 s) + post-connect verification; re-inject full model/encoding/keyterm config and replay the failed in-flight frame after reconnect (transcript timestamps stay monotonic).
- [ ] Rapid-failure breaker: 3 connections lasting <5 s → fatal config error, not infinite retry.
- [ ] Active cadence watchdogs: pipeline heartbeat (~1 s / ~10 s alarm) and input-audio gap watchdog (~0.5 s) **with recovery** (Pipecat's only comments — Syrinx must implement recovery).
- [ ] Graceful degradation per layer: STT low-confidence → clarify; TTS fail → fallback voice/canned clip; reasoning/tool fail → verbal ack/escalate. STT/TTS fallback adapters with availability events + background recovery probes.
- [ ] Drain on scale-down / deploy / SIGTERM (stop new sessions, let active calls finish) — never kill a live call like a stateless request.
- [ ] Bounded audio-in queue + load-aware admission (NB: no OSS clone bounds the audio-in queue — this is Syrinx greenfield).

## Demo / verify
Kill a provider socket mid-call → conversation recovers without dropping; SIGTERM during a call → call finishes, no new calls accepted.

## Blocked by
VE-01.

## Key references
notes: REL-01..13; wiki/rel-map. Deepgram failure-mode catalog (REL-10) as the incident runbook.
