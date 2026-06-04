# Final Voice-Engine Code Sweep — verdict: NOT production-ready

**Method.** Workflow `w2cdmzq6g`: 10 domain agents (/code-understand + /code-review) over the full engine (~16k LOC, current working tree with the uncommitted fixes), grounded in the verified checklist/bridges/prior-reviews; then an adversarial verify pass on every critical/high to kill false positives. 28 agents, 1.73M tokens.

**Totals:** 53 findings — **1 critical, 7 high, 21 medium, 24 low.** Area verdicts: **transport-core FAIL**, all 9 others **CONCERNS**.

## The meta-lesson (why prior passes missed these)
Two green tests gave FALSE confidence — exactly the "building on the wrong thing" risk:
1. The **WS multi-turn baseline rotates `contextId` per turn**, which masks a telephony-only multi-turn wedge (stable contextId).
2. The **Cartesia word-timestamp test feeds the wrong message shape**, masking a parser that emits zero timestamps against real Cartesia output.
A passing suite ≠ correct behavior when the test encodes the wrong assumption.

## CRITICAL (manager-verified directly against the code)
**C1 — Every telephony call wedges after turn 1.** `handleTurnComplete` drops any turn whose `contextId == lastFinalizedContextId` (`voice/src/voice-agent-session.ts:671`), `lastFinalizedContextId` is set once at `:676` and **never reset** (only 3 refs total), and the session **does not subscribe to `turn.change`**. Twilio/Telnyx/SmartPBX use **one stable contextId per call**; the WS client rotates per turn. ⟹ on any phone call, turn 2's `eos.turn_complete` is dropped as a duplicate and the agent never responds. The WS baseline (codex's fix) passes only because the browser rotates contextId. **Fix:** reset `lastFinalizedContextId` on `turn.change`/`vad.speech_started` for a new turn, or dedup on a per-turn key (contextId+turnSeq); add a stable-contextId multi-turn regression test.

## HIGH (verify-stage CONFIRMED unless noted)
- **H1 Google STT hardcodes 16000 Hz** (`voice-stt-google/src/index.ts:70,213`) — ignores configured rate; 8k telephony / 24-48k decoded as 16k → garbled transcripts. (verify: critical→high)
- **H2 Google STT loses in-flight audio on reconnect** — no replay buffer (`:100-114`); migrate onto shared `WebSocketConnection` like Deepgram.
- **H3 Single-owner is config-only, NOT a session invariant** (`voice-agent-session.ts:528-543`) — Deepgram EOS (default on) + Pipecat EOS double-finalize; the `endpointingOwner=provider_stt` default does not DISABLE the other owner; correctness relies on examples hand-disabling Deepgram EOS. (this is the deeper root behind C1's family.)
- **H4 Cartesia word-timestamps: wrong schema → emits ZERO timestamps live** (`voice-tts-cartesia/src/index.ts:268-287`) — parses `words[]` as objects, but Cartesia sends parallel arrays in a separate `type:"timestamps"` message; code only reads inside the `data`-guarded block. Breaks spoken-prefix reconstruction. Masked by a wrong-shape fixture.
- **H5 Cartesia cumulative per-chunk offset double-counts time** (`:266-285`) — mis-aligns captions/spoken-prefix even when timestamps do parse.
- **H6 llm-bridge per-turn state maps leak unboundedly** (`voice-bridge-aisdk/src/index.ts:146,219,225-236,363-372`) — errored/superseded turns never clear `turnUserText` etc.; grows across a long call.
- **H7 Outbound overflow at the new 200ms default is untested** (`outbound-playout-pipeline.test.ts:47,52-55`) — the test pins the cap to 30000 and a mock that emits 1 frame; the 200ms default's overflow/close path is unproven.

## MEDIUM highlights (21 total; full set in _reviews/final-sweep/*.json)
- Opus downlink zero-pads/flushes per `tts.audio` → silence injected mid-sentence (`index.ts:527-528`).
- DTMF before `start` emits `dtmf.received` with empty contextId (all 3 carriers).
- Telnyx throws + sends a carrier-error frame on normal reorder/duplicate chunks.
- SmartPBX interrupt doesn't flush carrier-buffered audio (talk-over window).
- Google STT has no low-confidence gate (verify: high→medium).

## What's solid (keep)
codex's fixes are real and correct as far as they go: single-owner *default*, 200ms queue, SIGTERM wiring, early-STT-finalization on the WS path, retry profile. Core unit logic is well-tested. The issues above are deeper integration/provider bugs the unit suite + WS baseline could not see.

## Recommendation
**HOLD — do not ship/commit as "done".** C1 + H1/H4 alone break telephony multi-turn and Cartesia alignment. Sequence: C1 (telephony wedge) → H3 (enforce single owner) → H1/H2 (Google STT rate+replay) → H4/H5 (Cartesia timestamps) → H6/H7 → mediums. Re-sweep after. Add the two missing regression tests (stable-contextId multi-turn; real-shape Cartesia timestamps) so the masking can't recur.
