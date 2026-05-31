# WT-03 / G15 — Browser outbound pacing + playout clock + client jitter buffer

- **Status:** Blocked (WT-01, WT-02) · **Priority:** P1 · **Phase:** 1
- **Area:** transport / browser · **Findings:** F4
- **Depends on:** WT-01, WT-02 · **Blocks:** WT-09
- **Catalog:** G15

## Problem / Evidence

The browser leg bursts TTS to the socket with no pacing and has no playout clock,
and the client has no jitter buffer:
- `index.ts:515` `tts.audio` handler sends each chunk straight to the wire; the
  browser server uses **`PacedPlayoutQueue` zero times** (telephony uses it).
- `index.ts` never instantiates `PlayoutProgressEmitter`, so the engine's
  playout-clock turn-taking (G12) **does not apply to the browser leg** — browser
  turn-taking falls back to generation-arrival timing, the exact thing G12 fixed
  for telephony.
- `voice-client-browser/src/index.ts` emits `{type:"audio"}` to handlers with no
  AudioContext scheduling / jitter buffer; playback timing is left to the demo HTML.

This is the leg every source flags as WebSocket's weak spot, and it is the
least-hardened. Deepgram guide (line 512-518): *"stream incrementally and buffer
just enough to prevent playback gaps. A short jitter buffer around 100 ms is
usually sufficient… consistent frames rather than buffered in large chunks."*
Kwindla §4.8: *"if you're directly using an API that sends raw audio frames
faster than realtime, you'll have to manually stop playout and flush audio
buffers."*

## Root cause (diagnose)

The browser path predates the paced-playout infrastructure and was never migrated
onto it; the playout clock was added for telephony only.

## Proposed solution (rfc)

1. **Server:** route the browser adapter's outbound TTS through the shared
   `OutboundPlayoutPipeline` (from WT-01) so it paces fixed-duration frames and
   drives `PlayoutProgressEmitter` — giving the browser leg the same playout clock
   + `tts.playout_progress` + barge-in-accurate truncation as telephony.
2. **Client (`voice-client-browser`):** add a real receive-side playout scheduler —
   an `AudioContext`-based jitter buffer (~100 ms target, configurable) that
   schedules decoded PCM on `currentTime + bufferAhead` and absorbs arrival
   variability; flush on `audio_clear`/`agent_interrupted`.

## Acceptance criteria
- [x] Browser server emits paced frames + `tts.playout_progress`; `PacedPlayoutQueue`
     and `PlayoutProgressEmitter` are used on the browser path.
- [x] Browser turn-taking/recording keys on playout-end (G12) like telephony.
- [x] Client schedules playback through an AudioContext jitter buffer; barge-in
     flushes it within one frame.
- [x] No audible gap under simulated jittery arrival (validated by headless Chrome smoke test).

## Test plan (TDD + smoke)
- **Unit:** browser adapter enqueues paced frames (assert frame count + cadence);
  `tts.playout_progress` emitted; client jitter buffer schedules N frames
  contiguously and flushes on clear.
- **Smoke (live):** extend the browser runtime capture smoke (headless Chrome) to
  assert assistant audio is scheduled through the jitter buffer and that an
  interruption clears it without playback error; capture the run artifact.

## Definition of done
Browser leg paced + playout-clocked + client-jitter-buffered, headless-Chrome
smoke proving scheduled playout and clean barge-in flush.

## Sources
Deepgram guide (jitter buffer ~100 ms); Kwindla §4.8 (manual playout/flush); F4.
