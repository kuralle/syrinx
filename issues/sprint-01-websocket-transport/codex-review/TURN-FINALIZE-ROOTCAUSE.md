# TURN-FINALIZE-ROOTCAUSE

Verdict: **not ready**. The timeout fallback is useful degradation, but the local root cause is still present: syrinx lets VAD-fragment context IDs race ahead of the Smart-Turn/finalize state machine, then waits for an unscoped Deepgram `Finalize` confirmation under the wrong context.

## Findings

1. `packages/voice-client-browser/index.html:636` — high — [integration] — **evidence:** the review studio treats every server `speech_ended` as an input-turn boundary: it drains the PCM queue and sets `activeTurn = null` at `packages/voice-client-browser/index.html:637-640`; the next above-threshold mic frame creates a new `review-*` context at `packages/voice-client-browser/index.html:713-719` and `packages/voice-client-browser/index.html:756-758`; each audio envelope carries that context at `packages/voice-client-browser/index.html:803-807`. But server-side Smart-Turn is the actual semantic turn decider: after VAD end it may defer incomplete turns at `packages/voice-turn-pipecat/src/index.ts:232-276`, `packages/voice-turn-pipecat/src/index.ts:309-319`, and only emits `eos.turn_complete` at `packages/voice-turn-pipecat/src/index.ts:371-383`. **Fix:** do not let browser VAD `speech_ended` create a new `contextId`; keep the capture context open until server semantic EOS (`eos.turn_complete` surfaced to the client as an explicit turn-accepted/committed event) or redesign context IDs as speech-burst IDs separate from semantic turn IDs.

2. `packages/voice-stt-deepgram/src/index.ts:155` — high — [correctness/integration] — **evidence:** when the websocket server sees a new client audio context it emits `turn.change` at `packages/voice-server-websocket/src/index.ts:631-635` and `packages/voice-server-websocket/src/index.ts:719-731`; Deepgram STT then clears prior-context finalize state at `packages/voice-stt-deepgram/src/index.ts:157-163` and changes `currentContextId` at `packages/voice-stt-deepgram/src/index.ts:164`. Later provider messages have no provider-side context, so `handleProviderMessage` attributes them to the mutable `currentContextId` at `packages/voice-stt-deepgram/src/index.ts:181-203` and releases only when that current context has `finalizeRequested` plus `speech_final || from_finalize` at `packages/voice-stt-deepgram/src/index.ts:224-242`. `requestProviderFinalize` sends one unscoped `{type:"Finalize"}` on the shared socket while its timeout is keyed to the requested context at `packages/voice-stt-deepgram/src/index.ts:272-289`. The `.handoff` probe `packages/voice-stt-deepgram/.handoff/finalize-contract-probe.test.ts` reproduces this: after `currentContextId` moves to `new-vad-fragment`, a fake provider sends `from_finalize:true` for the old finalize; metrics show `stt_provider_final_segment` on `new-vad-fragment`, while `old-vad-fragment` times out. **Fix:** make STT context/finalize transactional: one outstanding provider flush per stream, provider responses correlated to the pending finalize context, and no context reset that discards/renames pending provider state. Better: stop requiring provider finalize confirmation for turn text; see recommended architecture.

3. `packages/voice-stt-deepgram/src/index.ts:240` — high — [correctness] — **evidence:** in the live studio config, `emit_eos_on_final:false` and `finalize_on_speech_final:false` are set at `examples/02-hello-voice-headless/src/university-support-agent.ts:133-138`, so Deepgram STT withholds `stt.result` unless a finalize was requested and the provider frame has `speech_final` or `from_finalize`. A provider `is_final:true, speech_final:false` transcript is buffered but not emitted. Existing tests cover the drop path at `packages/voice-stt-deepgram/src/index.test.ts:520-592` and the fallback path at `packages/voice-stt-deepgram/src/index.test.ts:790-837`; the probe also shows no `stt.result` when `Finalize` is swallowed. **Fix:** emit provider `is_final` segments as STT results immediately, with provenance metadata if needed; let the turn/EOS layer decide turn completion. Keep provider `Finalize` as a best-effort flush signal, not a hard gate for releasing already received transcript text.

## Root Cause

Name: **VAD-fragment context drift plus strict unscoped Deepgram finalize gating**.

The root is not “Deepgram is slow.” It is the local architecture:

- The browser uses VAD `speech_ended` as a capture-context boundary, even though server Smart-Turn may still treat that pause as an incomplete semantic turn.
- The websocket transport converts the client’s next context into `turn.change`.
- The Deepgram STT plugin has one session-long provider socket and one mutable `currentContextId`; Deepgram responses are not context-scoped.
- Smart-Turn can emit delayed `stt.finalize` for the previous context after the browser has already moved audio to a new context.
- A later provider `from_finalize`/`speech_final` is evaluated against the new `currentContextId`, so the old context’s finalize timer is never satisfied and emits `Deepgram STT Finalize timed out before speech_final/from_finalize confirmation`.

This explains why clean single-utterance harness audio passes: it does not create the live VAD-fragment context drift. Short, restarted, and barge-in utterances do.

## Industry Comparison

Pipecat:

- Pipecat’s Deepgram service sends `Finalize` on VAD stop at `research/pipecat/src/pipecat/services/deepgram/stt.py:728-736`, but it still pushes every non-empty `is_final` Deepgram result as a `TranscriptionFrame` at `research/pipecat/src/pipecat/services/deepgram/stt.py:679-706`.
- `from_finalize` only marks a transcript as finalized through `confirm_finalize()` at `research/pipecat/src/pipecat/services/deepgram/stt.py:690-696` and `research/pipecat/src/pipecat/services/stt_service.py:191-214`; it is not the only way text reaches turn detection.
- Pipecat turn stop strategies wait for text plus VAD/turn-analysis/timeout conditions. Smart-Turn waits for turn complete plus finalized transcript or timeout at `research/pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:159-199` and `research/pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:255-277`; VAD/speech-timeout mode similarly uses VAD stop plus two timers and any transcript at `research/pipecat/src/pipecat/turns/user_stop/speech_timeout_user_turn_stop_strategy.py:26-46` and `research/pipecat/src/pipecat/turns/user_stop/speech_timeout_user_turn_stop_strategy.py:250-262`.

LiveKit:

- LiveKit JS Deepgram does not use explicit `Finalize` in the streaming plugin. It enables provider `endpointing` and `vad_events` at `research/agents-js/plugins/deepgram/src/stt.ts:183-205`, emits `FINAL_TRANSCRIPT` for every Deepgram `is_final` result at `research/agents-js/plugins/deepgram/src/stt.ts:364-399`, and emits `END_OF_SPEECH` from `speech_final` at `research/agents-js/plugins/deepgram/src/stt.ts:401-407`.
- LiveKit’s `AudioRecognition` then chooses the turn authority by mode. In VAD mode, VAD `END_OF_SPEECH` runs EOU detection at `research/agents-js/agents/src/voice/audio_recognition.ts:1353-1377`; in STT mode, provider `END_OF_SPEECH` runs EOU detection at `research/agents-js/agents/src/voice/audio_recognition.ts:972-1017`. EOU/turn detector adjusts delay but does not gate whether final STT text exists at `research/agents-js/agents/src/voice/audio_recognition.ts:1036-1184`.
- Manual commit flushes by adding silence and then appending interim text if final text is not ready at `research/agents-js/agents/src/voice/audio_recognition.ts:1618-1644`, again avoiding an indefinite provider-confirmation wait.

What syrinx does differently: it uses VAD to split client contexts, Smart-Turn to decide semantic EOS, Deepgram endpointing to emit `speech_final`, and explicit `Finalize` confirmation to release text. Those authorities are not ordered by a single state machine.

## Recommended Root Fix

1. Introduce a single turn authority and context lifecycle.
   - Preferred: server semantic EOS owns `contextId`. Browser `speech_ended` should only update UI and maybe flush queued PCM; it must not end the capture context. The server should send a distinct “turn committed / new turn id” signal after `eos.turn_complete` or assistant start.
   - Alternative: if choosing VAD as the authority, remove Smart-Turn as a semantic deferral layer for interactive mode and accept that every VAD end is a real endpoint.

2. Decouple STT final text from provider-finalize confirmation.
   - Emit `stt.result` for Deepgram `is_final` frames regardless of `speech_final/from_finalize`.
   - Include flags like `speechFinal`, `fromFinalize`, and `providerRequestId` as metadata or metrics.
   - Treat explicit `Finalize` as a best-effort flush, not as permission to release already received text.

3. If explicit `Finalize` remains, serialize/correlate it.
   - Maintain a single pending provider finalize transaction with the context that was current when it was sent.
   - Do not clear a pending old-context finalize on unrelated `turn.change`.
   - Attribute the next `from_finalize`/`speech_final` frame to the pending transaction, not the mutable `currentContextId`.

4. Keep `finalize_timeout_fallback` as a safety net after the root fix.
   - It should remain on for live conversation because it protects against provider anomalies.
   - It should become rarely exercised and emit a regression metric/alert. It should not be the normal completion path.

## VAD vs Smart-Turn Verdict

Replacing Smart-Turn with Silero-VAD-driven turn detection would remove one source of delayed old-context finalizes, so it would likely reduce this timeout class in the current studio. It is not sufficient by itself, because the explicit-Finalize gate can still drop or delay text when Deepgram sends `is_final` without `speech_final/from_finalize`.

VAD-only costs:

- More false endpoints on mid-thought pauses and restarted utterances.
- More premature agent interruptions unless silence thresholds are lengthened.
- Worse conversational quality than Pipecat/LiveKit’s model-assisted endpointing for incomplete thoughts.

Best answer: do not swap Smart-Turn out as the root fix. Fix context ownership and STT transcript release first. Then choose per profile:

- Interactive/reliability-first: VAD authority with 650-900ms silence, no strict Finalize wait, fallback on.
- Natural conversation: Smart-Turn/EOU authority, but browser context must follow semantic turn completion, not VAD fragments.

## Persona Checks

- Ideal user — not yet works-as-intended: a clean one-utterance harness passes, but the live path can move context before finalize confirmation; probe `finalize-contract-probe.test.ts` reproduces the old-context timeout.
- Hard-sell user — would reject the current architecture: “Waiting for assistant…” still depends on a fallback rather than deterministic turn completion.
- Bad user — rapid restart/barge-in breaks it: VAD fragment splits create new context IDs while old finalize work is still pending.
- Disappointed user — expectation gap: they expect short corrections like “again, so…” to stay one turn; the studio can split them into separate contexts before Smart-Turn decides.

## Verification

- `pnpm --filter @asyncdot/voice-stt-deepgram test` — 13 tests passed.
- `pnpm --filter @asyncdot/voice-turn-pipecat test` — 21 tests passed.
- `pnpm --filter @asyncdot/voice-stt-deepgram exec vitest run .handoff/finalize-contract-probe.test.ts` — 2 probe tests passed.

Unverified: I did not run a live browser mic session against real Deepgram in this review. The root race is proven with the local fake-provider probe and grounded in the live studio/context code path.
