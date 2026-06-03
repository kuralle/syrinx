# VE-03 — Barge-in / interruption

**Type:** AFK · **Tier:** Tier-0 · **Status:** Done (v2 — commits 2968a2b, dad711a, a9137ce, 6447166; see `.handoff/session-ve03-barge-in-close.md`)
**Master document:** [`../../PRODUCTION-CHECKLIST.md`](../../PRODUCTION-CHECKLIST.md) → **§4 Barge-In / Interruption**

## What to build
The user can interrupt the agent mid-speech and be heard immediately, with conversation history staying truthful to what was actually played.

## Acceptance criteria
- [ ] Input and output audio loops stay full-duplex during agent speech (mic open in barge-in mode; hard-mute only for explicit half-duplex).
- [ ] Interruption routed on a high-priority control lane ahead of audio/text data frames.
- [ ] On real interruption: abort speculative/active LLM **and** stop TTS **and** flush interruptible output **and** return to listening — as one sequence; preserve required control frames (terminal/tool) during flush.
- [ ] Assistant history records the **spoken prefix**, not the generated response (TTS word-timestamps when reliable; else playback-clock × speaking-rate estimate).
- [ ] Interruption gated by duration + confidence + backchannel classification (raw VAD spikes / "mm-hmm" don't derail the turn); false-interruption pause/resume where output can pause.
- [ ] Instrument onset→media-silent and onset→logic-cancel (target <100 ms is source-only — measure it in Syrinx).

## Demo / verify
Talk over the agent → it stops near-instantly and listens; the next LLM turn's history contains only what the user actually heard.

## Blocked by
VE-01, VE-02.

## Key references
notes: BARGE-01..09, TTS-08/11, TURN-11; wiki/barge-map.

## Current state (Syrinx)
Critical interrupt routing, TTS/LLM cancellation, playout clear, and approximate spoken-prefix history exist; missing work is measurement, backchannel/confidence gating, selective flush, browser playout precision, and false-interruption resume. See [`../reconcile/VE-03-bridge.md`](../reconcile/VE-03-bridge.md).
