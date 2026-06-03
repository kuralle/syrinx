# VE-05 — Latency budget & per-stage metrics

**Type:** AFK · **Tier:** Tier-0 · **Status:** Done (v2 — c19e95d, 93477a8 + budget doc; 4/5 bullets, monotonic/cancelled + provider instr carried to VE-07; see .handoff/session-ve05-latency-metrics-close.md)
**Master document:** [`../../PRODUCTION-CHECKLIST.md`](../../PRODUCTION-CHECKLIST.md) → **§6 Latency Engineering**, **§8 (core metric)**

## What to build
Make voice-to-voice latency the headline number and give every stage a measured budget line, so latency work is data-driven (not anecdotal).

## Acceptance criteria
- [ ] Per-stage first-token/first-byte metrics with monotonic timing + cancellation flags: LLM `ttft`, TTS `ttfb`, STT transcription delay, EOU `end_of_utterance_delay` vs `transcription_delay`; cancelled attempts excluded.
- [ ] Canonical v2v computed as `AgentStartedSpeaking − UserStoppedSpeaking` (UserStoppedSpeaking anchored to raw VAD silence minus hangover, so endpointing cost stays inside the number).
- [ ] Explicit turn budget across STT/endpointing/LLM/TTS/network; SLOs on **P95/P99**, not mean.
- [ ] Co-location of orchestrator + STT/LLM/TTS endpoints treated as an independent budget line (measure cross-region hop).

## Demo / verify
A dashboard/trace shows the per-stage breakdown of a real turn and the P95 v2v; a single slow stage is attributable.

## Blocked by
VE-01.

## Key references
notes: LAT-01..12, OBS-02/04/05; wiki/lat-map, obs-map.

## Current state (Syrinx)
Per-turn browser metrics exist for speech end, STT final, first LLM delta, first TTS byte, and playout, but there is no monotonic provider-stage metric backbone, cancellation flagging, P95/P99 aggregation, or explicit budget. See [`../reconcile/VE-05-bridge.md`](../reconcile/VE-05-bridge.md).
