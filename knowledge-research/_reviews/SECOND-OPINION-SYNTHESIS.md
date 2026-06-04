# Second-opinion synthesis (pi-kimi, independent) + cursor mediums

## Cross-validation of pi-kimi (reviewed committed 8484d19, blind to our findings)
**Validated our hardening:** kimi did NOT re-flag any of our fixed bugs as broken — no "Google STT 16k", no "Cartesia zero timestamps", no "lastFinalizedContextId telephony wedge". Independent confirmation the fixes landed.

**Found a real gap our sweep + fix + my verification all missed — CONFIRMED by manager:**
1. **Systemic per-contextId state leak (the C1 fix was partial).** Our fix cleared only `lastFinalizedContextId`; **3 sibling Sets leak** the same way (only `.clear()` on close, no per-turn delete):
   - `firstTtsAudioFired` (:224/:868) → `vaqi.latency_ms` not emitted on turn 2+ (stable contextId).
   - `interruptedGenerationContextIds` (:210/:925) → after a barge-in, turn N+1 (same contextId) silently drops late LLM/TTS packets.
   - `fallbackInjectedContexts` (:226/:1001) → only one error-fallback per CALL, not per turn.
   (`firstLlmDeltaReceived` is NOT a leak — deleted at :808/:927; kimi overstated this one.)
2. **`interrupt.stt` never emitted** — Deepgram STT listens (`voice-stt-deepgram:185`) but the session never pushes it → stale transcript segments leak into the post-barge-in turn.
3. **turn.change emitted on browser (`index.ts:795`) but NOT telephony** — telephony stable-contextId never triggers the turn.change resets.
Plus mediums: Deepgram TTS `currentContextId` race on rapid turns; Twilio start hardcodes 8kHz (rejects 16k trunks); Gemini TTS non-streaming; ProviderFallback built but unwired; no pre-roll buffer (STT-12); no denoiser (STT-11).

**Sharp meta-point:** the C1 regression test only asserts `userInputs.length` — it does NOT assert the `vaqi.latency_ms`/guard regressions, so it passes while the sibling leaks persist.

## Verdict
**Still NOT-READY for telephony multi-turn.** Our hardening fixed the headline bugs (verified), but C1 was one symptom of a systemic per-contextId-state-leak class; the siblings + `interrupt.stt` remain. Next must-fix: clear all per-contextId guard Sets on `eos.turn_complete`/`vad.speech_started` (or key by turn nonce); emit `interrupt.stt` on barge-in; emit `turn.change` on telephony; strengthen the multi-turn test to assert the guard regressions. Then re-sweep.

## cursor (4 deferred mediums) — DONE + manager-verified, uncommitted
Opus per-packet flush (end-of-context only), DTMF-before-start guard (all 3 carriers, `<carrier>.dtmf.before_start` metric), Telnyx reorder→`media_chunk_duplicate` metric (no throw), SmartPBX clear-on-interrupt. My own `pnpm -r typecheck`+`test` exit 0. Independent of the kimi findings — safe to keep.
