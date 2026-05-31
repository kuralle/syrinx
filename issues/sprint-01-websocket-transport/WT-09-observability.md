# WT-09 / G21 — Metrics wiring + per-turn timestamps + browser loss/jitter smoke

- **Status:** In Review · **Priority:** P2 · **Phase:** 2
- **Area:** observability · **Findings:** transport-strategy corpus (measure, don't argue)
- **Depends on:** WT-01, WT-03 · **Blocks:** —
- **Catalog:** G21

## Problem / Evidence

- The client protocol already defines a `metrics` message
  (`voice-client-browser/src/index.ts:57` — `sttMs/llmTTFTMs/ttsTTFBMs/e2eMs`) but
  the **server never emits it** (no `metrics` push in `index.ts wireSessionEvents`).
- No standardized per-turn timestamp set. Both corpora demand four:
  text-ready, first-audio-byte, first-audio-played, last-audio-played
  (Source-5 article; Kwindla "instrument true voice-to-voice"). Kwindla §4.6.1 also
  warns WebSocket observability is *"between very hard and impossible"* — so it must
  be built deliberately.
- The telephony emulator has `clean|jittery|bursty` profiles, but the **browser
  leg has no packet-loss/jitter smoke** — the leg the corpus most wants tested
  under impairment.

## Root cause (diagnose)

Instrumentation grew per-transport ad hoc; the browser leg never got an impairment
harness or a populated metrics channel.

## Proposed solution (rfc)

1. Emit the `metrics` message from the server per turn with the four canonical
   timestamps + the derived stage latencies (speech-end→STT-final,
   STT-final→first-LLM-text, first-text→first-TTS-audio, speech-end→first-audio).
   Source the playout timestamps from `PlayoutProgressEmitter` (WT-03).
2. Add a per-turn correlation id tying TTS timing to STT/barge-in events.
3. Add a **browser loss/jitter smoke**: inject delay/drop on the browser socket
   path (mirror the telephony network profiles) and assert no playback gap with the
   WT-03 jitter buffer + that the metrics report the added latency.
4. Defend the ~800 ms voice-to-voice budget (Kwindla) as an SLO assertion in the
   interactive smoke (warn, not fail, with P50/P95 logged).

## Acceptance criteria
- [x] Server emits populated `metrics` per turn (4 timestamps + stage latencies + correlation id).
- [x] Browser loss/jitter smoke exists and passes with the jitter buffer absorbing impairment.
- [x] Interactive smoke logs P50/P95 voice-to-voice and asserts the SLO band.

## Test plan (TDD + smoke)
- **Unit:** metrics computed correctly from synthetic stage events; correlation id stable per turn.
- **Smoke (live):** browser runtime smoke under injected jitter/loss → no gap +
  metrics reflect impairment; interactive smoke prints P50/P95 budget.

## Definition of done
Real per-turn metrics flow to the client, browser leg is tested under impairment,
and voice-to-voice budget is measured as an SLO.

## Sources
Level-Up / Deepgram (four timestamps); Kwindla (800 ms budget, observability hard); F4/F6 context.
