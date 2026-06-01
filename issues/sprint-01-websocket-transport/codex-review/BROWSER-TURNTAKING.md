# Browser Turn-Taking: Pipecat/LiveKit Grounding and Syrinx Recommendation

Verdict: **not ready**. Syrinx does not need browser VAD to decide end-of-turn, but the browser studio should add browser VAD/local speech-start for **barge-in and pre-speech only**. The overlap is primarily a studio transport/playout problem: local user speech does not immediately clear assistant audio or send an explicit interrupt, so the existing server-side interrupt path is reached late or not at all.

Research scope: syrinx at `3fcbff58cb075e72e97da5634d7680f6925109b4`; Pipecat repos under `research/pipecat*`; LiveKit repos under `research/agents-js`, `research/agents-playground`, `research/components-js`, `research/client-sdk-js`. I cloned missing Pipecat/LiveKit browser/playground repos into the research directory and read the code paths cited below.

## 1. Browser VAD

`packages/voice-client-browser/index.html:710` — high — [Integration] — syrinx studio computes RMS and starts a capture turn when `inputRms >= startRmsThreshold`; while no `activeTurn`, below-threshold PCM is only kept in `preSpeechQueue` and not sent. This is an energy gate, not a VAD/EOU model. — Add browser VAD/local speech-start for fast barge-in/pre-speech; do not use it as an EOS commit signal.

`packages/voice-client-browser/index.html:720` — high — [Integration] — when RMS opens a new capture turn, the studio calls `flushOutputAudio()`, creates a new `contextId`, and sends pre-speech; this is the only immediate local overlap mitigation. Soft/late threshold crossings still overlap until this line runs, and the server sees a fresh context after a previous `turn_complete`. — Use VAD speech-start before context creation to clear playout and send an explicit interrupt.

`research/pipecat-client-web-transports/transports/websocket-transport/src/webSocketTransport.ts:244` — medium — [Integration] — Pipecat web websocket transport sends every recorder callback chunk to the server when ready; it does not gate audio with browser VAD in this path. — Do not copy Pipecat by adding client EOS; copy the continuous/low-latency audio path or add VAD only as a local UX signal.

`research/pipecat-client-web-transports/lib/media-mgmt/mediaManager.ts:233` — medium — [Integration] — Pipecat browser recording invokes `_userAudioCallback(data.mono)` directly for each recorder chunk. — Continuous audio streaming avoids missing quiet continuation frames that syrinx's RMS gate can suppress.

`research/pipecat-client-web-transports/lib/media-mgmt/mediaManager.ts:131` — medium — [Frontend/UX] — Pipecat has a client-side playout interrupt hook: `userStartedSpeaking()` calls `_wavStreamPlayer.interrupt()`. The generic websocket client receives `USER_STARTED_SPEAKING` as a callback at `research/pipecat-client-web/client-js/client/client.ts:1124`, so applications can wire local playout interruption to speech-start. — Syrinx studio should expose the same local playout interrupt semantics directly.

`research/agents-playground/src/components/playground/Playground.tsx:143` — medium — [Integration] — LiveKit playground enables the local microphone with `room.localParticipant.setMicrophoneEnabled(...)`; there is no browser Silero/ONNX VAD in the playground path. — Treat LiveKit browser as media transport/UI, not EOU authority.

`research/client-sdk-js/src/room/track/create.ts:99` — medium — [Integration] — LiveKit client SDK captures microphone via `navigator.mediaDevices.getUserMedia` and wraps tracks; turn decisions live outside this browser capture code. — Browser VAD in syrinx should be an added studio affordance, not a core turn detector replacement.

`research/components-js/packages/react/src/hooks/useTrackVolume.ts:27` — low — [Frontend/UX] — LiveKit components use Web Audio analysers for volume visualization, not turn completion. `research/client-sdk-js/src/room/Room.ts:1922` updates `isSpeaking`/`audioLevel` from server speaker updates. — Do not mistake level meters/active-speaker UI for a real browser VAD policy.

Recommendation: **yes, add browser VAD to syrinx studio**, but only for responsive speech-start. Use a proven browser VAD such as Silero WASM/ONNX via `@ricky0123/vad-web` or equivalent, with a short pre-speech ring buffer. It buys: immediate local playout clear, explicit interrupt hint to server, quieter/more robust speech-start than RMS, and better pre-speech capture. It must not become a raw silence finalize timer.

## 2. Multi-Sentence / Mid-Thought Pause

`research/pipecat/src/pipecat/audio/turn/smart_turn/base_smart_turn.py:27` — high — [Correctness] — Pipecat Smart Turn has a 3s default silence timeout, 500ms pre-speech, and 8s max window; `append_audio()` resets silence on speech and only marks complete from raw silence when `_silence_ms >= _stop_ms` at line 127. — Syrinx should not use a short raw-VAD silence timer as EOS.

`research/pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:159` — high — [Correctness] — Pipecat waits for VAD stop, runs the turn analyzer, sets `_turn_complete = state == COMPLETE`, then waits for finalized transcript or STT timeout before triggering turn stop. — Keep EOU as VAD + model + transcript finalization, not VAD alone.

`research/pipecat/src/pipecat/audio/vad/vad_analyzer.py:24` — medium — [Correctness] — Pipecat VAD defaults are `start_secs=0.2`, `stop_secs=0.2`, confidence `0.7`, min volume `0.6`; state changes require start/stop frame counts at `vad_analyzer.py:229`. — VAD boundaries are intentionally quick, but Smart Turn is the guard against premature turn completion.

`research/agents-js/plugins/silero/src/vad.ts:36` — medium — [Correctness] — LiveKit Agents JS Silero defaults use 50ms min speech, 550ms min silence, 500ms prefix padding, threshold 0.5. — Syrinx's server VAD settings are not obviously too aggressive versus LiveKit; the gap is later fusion/transport behavior.

`research/agents-js/agents/src/voice/turn_config/endpointing.ts:37` — medium — [Correctness] — LiveKit endpoint defaults are fixed min 500ms/max 3000ms; dynamic endpointing adapts pause estimates and can raise delay to max. — Syrinx interactive `finalize_delay_ms=250` is faster than LiveKit's default minimum and has less room to absorb mid-thought pauses.

`research/agents-js/agents/src/voice/audio_recognition.ts:1071` — high — [Correctness] — LiveKit runs an EOU model after speech stop; if `endOfTurnProbability < unlikelyThreshold`, it sets `endpointingDelay = endpointing.maxDelay` at line 1091, then sleeps that delay before commit at line 1120. — Syrinx should defer longer when semantic/EOU confidence is weak instead of shortcutting quickly.

`research/agents-js/plugins/livekit/src/turn_detector/base.ts:235` — high — [Correctness] — LiveKit turn detector predicts EOU from chat context; it uses the `livekit/turn-detector` ONNX model from `constants.ts:14` and language thresholds from `base.ts:206`. — Syrinx's `semantic-completeness.ts` is a heuristic, not an EOU model.

`packages/voice-turn-pipecat/src/semantic-completeness.ts:24` — high — [Correctness] — syrinx marks trailing fillers such as `um|uh|er|hmm` incomplete, but also marks any transcript with `words >= 5` complete at line 99. — This can override mid-thought uncertainty for partial phrases that are longer than five words.

`packages/voice-turn-pipecat/src/index.ts:322` — high — [Correctness] — if Smart-Turn is incomplete but heuristic semantic says complete, syrinx schedules a semantic shortcut after `semanticShortcutDelayMs` default 50ms. — Disable or lengthen this shortcut for interactive browser voice; require stronger model evidence before committing.

`examples/02-hello-voice-headless/src/university-support-agent.ts:140` — medium — [Correctness] — interactive server VAD is threshold 0.5, min silence 650ms, pad 180ms; `packages/voice-vad-silero/src/index.ts:176` adds silence plus pad before `speech_ended`, so the real speech-ended point is around 830ms. — The early reply is less likely caused by Silero being too short and more likely by EOS fusion after the boundary.

Why Smart-Turn did not defer: if the pause produced server VAD `speech_ended`, syrinx analyzed Smart-Turn and fused it with the heuristic transcript. A filler-ending transcript can defer, but a partial with punctuation or at least five words can become `semanticComplete`, and the 50ms semantic shortcut can force finalization even when Smart-Turn itself was incomplete. If Smart-Turn probability crossed 0.5, `smartTurnComplete && semanticComplete` releases after only `finalize_delay_ms=250`.

## 3. Audio Overlap / Barge-In

`packages/voice/src/voice-agent-session.ts:548` — high — [Integration] — core barge-in is server-VAD gated: only `handleVadSpeechStarted` during active TTS calls `turnArbiter.onSpeechStarted`. Speech activity then must satisfy the arbiter duration threshold. — Browser overlap cannot be fixed solely by core if the browser delays or suppresses speech-start audio.

`packages/voice/src/turn-arbiter.ts:40` — high — [Integration] — arbiter enters pending interrupt on speech start during TTS and commits only after `minInterruptionMs`; default is 280ms from `packages/voice/src/voice-agent-session.ts:205`. — This is a useful authoritative server guard but too late to be the first audible playout clear in a browser.

`packages/voice-server-websocket/src/index.ts:528` — high — [Integration] — websocket server already sends `audio_clear` and `agent_interrupted` when `interrupt.tts` fires. `packages/voice-server-websocket/src/outbound-playout-pipeline.ts:83` also clears queued playout and drops interrupted context audio. — The server clear path exists; the missing piece is timely trigger from browser speech-start.

`packages/voice-client-browser/index.html:643` — high — [Frontend/UX] — browser studio honors server `audio_clear` by calling `flushOutputAudio()`. — If users hear overlap, the clear event is arriving late/not at all, not ignored once received.

`packages/voice-client-browser/index.html:932` — high — [Frontend/UX] — `flushOutputAudio()` stops active Web Audio sources, empties the output queue, and resets playback timing. — Reuse this immediately on local browser VAD speech-start while assistant playout is active.

`research/pipecat/src/pipecat/processors/aggregators/llm_response_universal.py:895` — medium — [Integration] — Pipecat broadcasts interruption when a new user turn starts and interruptions are enabled. `research/pipecat/src/pipecat/transports/base_output.py:535` cancels output tasks/queues on `InterruptionFrame`, and `research/pipecat/src/pipecat/transports/websocket/fastapi.py:433` clears websocket audio send buffer. — Syrinx already has the analogous server pieces; it needs the browser-side fast trigger.

`research/agents-js/agents/src/voice/agent_activity.ts:1185` — medium — [Integration] — LiveKit interrupts by audio activity once VAD speech duration reaches the configured min duration; defaults are 500ms at `turn_config/interruption.ts:62`. The interrupted speech path calls `audioOutput.clearBuffer()` at `agent_activity.ts:2589`. — LiveKit clears playout where the audio source queue lives; syrinx browser owns its own Web Audio queue and must clear it locally too.

Root cause of the observed overlap: after a premature `turn_complete`, syrinx browser sets `activeTurn = null` at `packages/voice-client-browser/index.html:658`. A continuation must cross the RMS threshold, create a new context, send audio, reach server Silero, then satisfy `minInterruptionMs` before the server emits `audio_clear`. Until then, Web Audio continues playing queued TTS. This explains the reported overlap even though server and browser have clear handlers.

## 4. Ordered Recommendation

1. **Studio-only: add local browser VAD speech-start and immediate playout flush.** In `packages/voice-client-browser/index.html`, replace/augment the RMS open gate with browser VAD speech-start. On VAD speech-start while assistant output is active, call `flushOutputAudio()` immediately, mark UI `interrupted`, keep pre-speech buffering, and then open/send the capture context. This mirrors Pipecat's `userStartedSpeaking()->interrupt()` and compensates for syrinx's browser-owned Web Audio queue.

2. **Transport/core integration: add an explicit client interrupt control message.** Add a websocket JSON message such as `{type:"client_interrupt", reason:"local_vad_speech_start", assistantContextId}`. In `packages/voice-server-websocket/src/index.ts`, validate it against an active TTS context and push the existing interrupt path (`interrupt.detected`/`interrupt.tts`) so queued server audio is dropped and a confirming `audio_clear` is sent. Keep server VAD interruption as authoritative/idempotent.

3. **Core EOS tuning: stop the 50ms heuristic semantic shortcut from committing browser turns.** In `packages/voice-turn-pipecat/src/index.ts`, disable or materially lengthen `semanticShortcutDelayMs` for interactive profile, and stop treating the `words >= 5` heuristic in `semantic-completeness.ts` as strong completion. Require Smart-Turn complete for quick release, or defer to `incomplete_fallback_ms` when semantic confidence is weak. This addresses the "…um…" case without resurrecting naive raw-VAD silence finalization.

4. **Config: make interactive endpointing less eager.** In `examples/02-hello-voice-headless/src/university-support-agent.ts`, raise `finalize_delay_ms` above 250ms and consider increasing `incomplete_fallback_ms`/semantic defer for browser studio. Do not increase server VAD silence as the primary fix; Pipecat and LiveKit keep VAD reasonably responsive and rely on EOU/Smart-Turn to defer.

5. **Regression tests/smokes.** Add a browser studio test for assistant playout + local speech-start: assert `flushOutputAudio()` occurs before server `audio_clear`. Add turn plugin tests for mid-thought partials (`"I was wondering if um"`, `"I need help with my application and"`) that must not finalize via semantic shortcut. Add websocket tests for `client_interrupt` ensuring `audio_clear` is sent and later TTS chunks for the interrupted context are dropped.

## Persona Checks

Ideal user — not satisfied today: `packages/voice-client-browser/index.html:658` closes the active turn on server `turn_complete`, so a natural continuation becomes a new context; tests run cover existing clear mechanics, not this UX path.

Hard-sell user — would reject overlap: `packages/voice-client-browser/index.html:932` can stop output immediately, but it is not called from a real local VAD event; it waits for RMS/open or server clear.

Bad user — soft/hesitant speech can break the flow: below `startRmsThreshold` at `packages/voice-client-browser/index.html:710`, continuation frames remain local pre-speech and cannot trigger server interruption.

Disappointed user — "Smart-Turn should know I wasn't done" is partly valid: `packages/voice-turn-pipecat/src/semantic-completeness.ts:99` and `packages/voice-turn-pipecat/src/index.ts:322` can make a heuristic "complete" transcript finalize faster than Pipecat/LiveKit-style EOU deferral.

## Tests Run

- `pnpm vitest run src/studio-page.test.ts src/audio.test.ts` in `packages/voice-client-browser`: 10 passed.
- `pnpm vitest run src/browser-pacing.test.ts src/outbound-playout-pipeline.test.ts --fileParallelism=false` in `packages/voice-server-websocket`: 6 passed.
- `pnpm vitest run src/semantic-completeness.test.ts src/index.test.ts` in `packages/voice-turn-pipecat`: 21 passed.

Initial attempts with `pnpm --dir`/`pnpm -C` failed before Vitest because this pnpm invocation interpreted the package path as a command; rerunning from each package workdir succeeded.

## Unverified

I did not run a live browser studio with microphone and audible TTS. The conclusion is code-grounded: browser clear and server clear exist, but no local browser VAD/control interrupt path exists to trigger them at speech onset.
