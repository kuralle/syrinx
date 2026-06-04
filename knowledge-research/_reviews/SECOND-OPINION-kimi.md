# Syrinx Voice Engine — Independent Production-Readiness Review

**Reviewer:** Kimi (fresh senior voice-infra reviewer)  
**Commit:** `8484d19` (frozen snapshot)  
**Scope:** speech-in → speech-out only (transport, STT, VAD/turn-taking, barge-in, TTS, orchestration, reliability, observability)  
**Method:** Read-only code trace; no test execution (no node_modules). Read SPEC (PRODUCTION-CHECKLIST.md + domain maps) only; prior reviews in `_reviews/` were NOT consulted.

---

## Overall Verdict: NOT-READY

The architecture is sound — priority bus, typed packets, stateful resamplers, paced playout, and explicit turn arbitration show real systems thinking. However, **three blocking correctness defects** undermine multi-turn operation (the normal mode for telephony and long browser sessions), and **two missing control-plane signals** break the contract between the orchestrator and provider plugins. These are not polish items; they cause dropped turns, misattributed transcripts, missing audio, and wrong history on barge-in.

### Top Blockers
1. **Per-contextId state leaks across turns** — `firstTtsAudioFired`, `interruptedGenerationContextIds`, `firstLlmDeltaReceived`, `fallbackInjectedContexts` are `Set<string>` / `Map<string, …>` that are never cleared when a turn ends. With a **stable contextId** (telephony `callSid`, or any transport that reuses one session identifier), the second turn inherits stale guard flags from the first. This suppresses `vaqi.latency_ms`, drops late LLM/TTS packets erroneously, disables latency-filler splicing, and prevents error fallbacks after the first failure.  
2. **`turn.change` is defined but never emitted** — STT plugins (Deepgram, Google) listen for `turn.change` to reset `currentContextId` and `streamStartTime`, yet no component ever pushes this packet. In browser mode with rotating turn IDs, a late provider final can arrive after the next turn’s first audio packet has already moved `currentContextId`, causing the final to be misattributed to the wrong turn.  
3. **`interrupt.stt` is never emitted** — The session emits `interrupt.tts` and `interrupt.llm` on barge-in, but `interrupt.stt` is never pushed. The Deepgram STT plugin registers a handler that resets transcript state on `interrupt.stt`; because it never fires, provider transcript buffers (`transcriptStateByContextId`, `finalizedContextIds`, etc.) carry stale segments into the new turn after a barge-in, risking composite transcripts or duplicate finals.

---

## Findings

### CRITICAL

**`packages/voice/src/voice-agent-session.ts:437-447` — `firstTtsAudioFired` Set never cleared between turns with same contextId — Observability / Multi-turn**  
Evidence: `firstTtsAudioFired` is a `Set<string>`; `add()` is called on the first `tts.audio` per contextId. It is only cleared in `closeOnce()` (session shutdown). For telephony using `callSid` as the stable `contextId`, the second turn will find the contextId already in the set, so `vaqi.latency_ms` is never emitted and `watchdogs.clearVaqiIfContext` is never called.  
Recommendation: Clear `firstTtsAudioFired` for a contextId when `eos.turn_complete` or `vad.speech_started` fires for that contextId, or maintain per-turn state keyed by `(contextId, turnSequence)`.

**`packages/voice/src/voice-agent-session.ts:438` — `interruptedGenerationContextIds` Set never cleared between turns — Barge-in / Multi-turn**  
Evidence: `interruptedGenerationContextIds.add(pkt.contextId)` in `handleInterruptDetected`. The Set is only cleared on session `close()`. After a barge-in on turn N with stable contextId `c`, turn N+1 inherits the flag. Late LLM/TTS packets for turn N+1 (which was *not* interrupted) are then silently dropped by `handleLlmDelta`, `handleLlmDone`, and `handleTtsAudio`.  
Recommendation: Remove the contextId from the Set when `eos.turn_complete` or `tts.end` arrives for that contextId, or scope the flag to a turn nonce.

**`packages/voice/src/voice-agent-session.ts:451` — `firstLlmDeltaReceived` Set never cleared — Latency / Multi-turn**  
Evidence: `firstLlmDeltaReceived.add(pkt.contextId)` in `handleLlmDelta`. Never removed. For a second turn with the same contextId, `latencyFiller.spliceLlmDelta` is skipped, so the filler connective is not stripped from the real response.  
Recommendation: Delete the contextId from the Set on `eos.turn_complete` or `llm.done`.

**`packages/voice/src/voice-agent-session.ts:581` — `fallbackInjectedContexts` Set never cleared — Reliability / Multi-turn**  
Evidence: `fallbackInjectedContexts.add(contextId)` in `maybeSpeakErrorFallback`. Never removed. After one recoverable LLM error on a stable contextId, no further error fallback can ever be spoken for that call.  
Recommendation: Clear the contextId on `eos.turn_complete`.

**`packages/voice/src/voice-agent-session.ts:350` — `turn.change` is listened for but never emitted — Turn-taking / STT**  
Evidence: The session wires `bus.on("turn.change", …)` to clear `lastFinalizedContextId`, and both Deepgram and Google STT plugins wire `bus.on("turn.change", …)` to reset `currentContextId`. A global search of the source tree finds no call site that ever pushes a `TurnChangePacket` onto the bus.  
Recommendation: Emit `turn.change` from `handleVadSpeechStarted` (or from a new turn-start handler) with the new `contextId` and `previousContextId`. Add a factory in `packet-factories.ts`.

**`packages/voice/src/voice-agent-session.ts:541-543` — `interrupt.stt` is never emitted — Barge-in / STT**  
Evidence: `handleInterruptDetected` pushes `make.interruptTts` and `make.interruptLlm` on Route.Critical, but there is no `make.interruptStt` push. Deepgram STT (`voice-stt-deepgram/src/index.ts:200-203`) listens for `interrupt.stt` and calls `resetTurnTranscriptState()`, which never fires. After barge-in, stale `finalTranscriptParts` and `finalizedContextIds` persist into the new turn.  
Recommendation: Add `bus.push(Route.Critical, make.interruptStt(pkt.contextId, pkt.timestampMs))` in `handleInterruptDetected`, and ensure the Pipecat EOS plugin also listens for it.

**`packages/voice-stt-deepgram/src/index.ts:284-289` — `contextIdForProviderFinal` correlates with oldest pending finalize, risking misattribution — STT**  
Evidence: `pendingProviderFinalizeContextIds[0]` returns the first (oldest) pending context. If two turns are pending finalization (rapid back-to-back speech), a `speech_final` from the provider is correlated with the older turn even if it belongs to the newer one.  
Recommendation: Use a FIFO queue with correlation tokens, or correlate only on `fromFinalize` (which is request/response paired) and keep `currentContextId` for all other finals.

**`packages/voice-tts-deepgram/src/index.ts:179` + `:254` — Deepgram TTS `currentContextId` overwritten on every `speak`, causing audio misattribution — TTS**  
Evidence: `speak()` sets `this.currentContextId = contextId;`. `handleAudio()` emits binary PCM using `this.currentContextId`. Deepgram’s socket has no per-message context id; it processes `Speak` messages sequentially. If a second `tts.text` (new turn) is sent before the first turn’s `Flushed` ack arrives, `currentContextId` swings to the new turn, and the remaining audio from the first speak is misattributed.  
Recommendation: Queue audio attribution by tracking the in-flight `speak` sequence: increment a counter on `Speak`, decrement on `Flushed`, and emit audio under the turn that sent the corresponding `Speak`.

### HIGH

**`packages/voice/src/voice-agent-session.ts:265-270` + `:581-591` — LLM error fallback silently hangs if TTS is also broken — Reliability**  
Evidence: `maybeSpeakErrorFallback` checks `pkt.component !== "llm"` but does not verify a TTS plugin is alive. If LLM failed and TTS is down, the injected fallback message routes into a dead TTS path and the caller hears dead air — violating the "never fail silently" rule it claims to enforce.  
Recommendation: Gate fallback injection on a TTS health signal, or switch to a canned-audio fallback path when TTS is known to be unhealthy.

**`packages/voice/src/turn-arbiter.ts:72-74` — `latestInterimConfidence` and `latestInterimText` are global, not per-context — Barge-in**  
Evidence: `noteInterimEvidence` overwrites module-level variables. A low-confidence interim from turn N can suppress the barge-in commit for turn N+1 if the user starts speaking before a new interim arrives.  
Recommendation: Scope `latestInterimText` and `latestInterimConfidence` to the pending interruption state or to a per-context map.

**`packages/voice/src/turn-arbiter.ts:42-59` — Backchannel suppression is a hardcoded English list — Barge-in / Robustness**  
Evidence: `BACKCHANNELS` contains 20 English fillers. It misses "yes", "no", "go on", "absolutely", "sure thing", and is entirely English-centric. Non-English backchannels pass through and may suppress real interruptions.  
Recommendation: Replace with an ML backchannel classifier (LiveKit-style ONNX) or at least expand the list and make it locale-configurable.

**`packages/voice/src/voice-agent-session.ts:265-270` — No pre-roll / look-back buffer before VAD start — STT / Audio**  
Evidence: `handleUserAudio` fans audio directly to `vad.audio` and `stt.audio` with no delay line. The Silero VAD plugin (`voice-vad-silero/src/index.ts`) processes 512-sample (32 ms) windows with no pre-roll. Production checklist (STT-12) calls for ~500 ms look-back replayed on speech start.  
Recommendation: Add a rolling 500 ms PCM buffer to `handleUserAudio` (or a pre-roll plugin) and replay it into the VAD/STT pipeline on `vad.speech_started`.

**`packages/voice-server-websocket/src/twilio.ts:286-296` — Twilio start validation hardcodes 8 kHz expectation — Transport**  
Evidence: `validateTwilioStart` throws if `sampleRate !== expectedSampleRateHz` (default 8000). Twilio supports 16000 Hz streams on some trunks. A carrier upgrade would cause immediate fatal session rejection.  
Recommendation: Accept any declared sample rate and resample to the engine rate, or make `expectedSampleRateHz` configurable per-deployment.

### MEDIUM

**`packages/voice-stt-deepgram/src/index.ts:183` — `currentContextId` updated on every `stt.audio` packet, creating race with late provider finals — STT**  
Evidence: `sendAudio` updates `this.currentContextId = audioPkt.contextId;`. A late `is_final` from the provider (network reordering or buffer flush) uses `currentContextId` when `speechFinal === false && fromFinalize === false`, attributing it to whatever turn sent audio most recently.  
Recommendation: Only update `currentContextId` on explicit turn-boundary events, not on every audio packet.

**`packages/voice-tts-gemini/src/index.ts` — Gemini TTS is non-streaming and buffers text until `tts.done` — TTS / Latency**  
Evidence: The plugin accumulates text in `textByContextId` and sends one HTTP request on `tts.done`. Time-to-first-audio is the full synthesis latency, not streaming. For a 5-sentence response, this adds hundreds of milliseconds to perceived v2v latency versus sentence-streaming providers.  
Recommendation: Document as degraded path; consider blocking Gemini TTS from latency-critical deployments or adding a sentence-level batching wrapper.

**`packages/voice/src/voice-agent-session.ts:265-270` — No denoiser plugin in the default pipeline — Audio**  
Evidence: `DenoiseAudioPacket` and `DenoisedAudioPacket` exist in the packet taxonomy, but no denoiser plugin ships in the repo and `handleUserAudio` does not route audio through one. The checklist (STT-11) calls for denoising before VAD.  
Recommendation: Ship a minimal RNNoise or Speex denoiser plugin, or document that the transport layer must provide clean audio.

**`packages/voice/src/provider-fallback.ts` — ProviderFallback exists but is never wired by STT/TTS plugins — Reliability**  
Evidence: `ProviderFallback` implements cross-provider failover with health probes, but Deepgram STT, Google STT, Cartesia TTS, and Deepgram TTS each instantiate a single `WebSocketConnection` with no fallback.  
Recommendation: Wrap provider sockets in `ProviderFallback`, or remove the unused code to avoid misleading readers.

**`packages/voice/src/tts-playout-clock.ts:57-62` — `scheduleRelease` timer may fire after `release` was already called manually — Race**  
Evidence: `release(contextId)` clears the timer, but if `noteProgress(contextId, true)` calls `release` while a `setTimeout` for the same contextId is already queued, the timer callback later checks `this.realPlayoutContexts.has(contextId)` and returns. This is safe today, but the guard depends on `realPlayoutContexts` state; if `noteProgress` is never called, the timer fires and calls `release` a second time (idempotent but sloppy).  
Recommendation: Add a generation counter or check `this.active.has(contextId)` inside the timer callback before releasing.

### LOW

**`packages/voice/src/audio/resample.ts:90-110` — `StreamingPcm16Resampler` uses symmetric FIR with edge taper on every chunk — Audio**  
Evidence: `firDecimate` processes a full chunk with centered FIR; edge samples lack full tap support, causing amplitude taper at chunk boundaries. For very small chunks (< 127 samples) this is audible. The checklist (XPORT-03) calls for stateful streaming resampling with preserved history, which is partially done, but the centered FIR design still loses edge energy.  
Recommendation: Switch to a causal FIR (or polyphase) with history carry-forward, accepting the group-delay shift in exchange for no edge taper.

**`packages/voice/src/pipeline-bus.ts:151-158` — `stop()` drains Critical+Main synchronously but fires handler errors into the void — Reliability**  
Evidence: `dispatchSync` catches errors and swallows them. A handler that throws during shutdown may leave a plugin in a partially-cleaned state without surfacing the error.  
Recommendation: Log or bus-emit shutdown handler errors so they are visible in incident reconstruction.

---

## Per-Domain One-Line Verdicts

| Domain | Verdict |
|---|---|
| **Audio Transport** | Solid — resampling, µ-law, Twilio serializer, paced playout, jitter bounds, DTMF routing, and graceful drain are all present and mostly correct. Missing Opus FEC config and µ-law passthrough are Tier-1 gaps, not blockers. |
| **STT Ingestion** | Concern — Deepgram plugin has good reconnect/replay/finalize logic, but the missing `turn.change`/`interrupt.stt` signals and the `currentContextId` race create real misattribution bugs. No cross-provider fallback. |
| **Turn-Taking** | Concern — TurnArbiter has proper G1 gate, backchannel suppression, and primary-speaker fingerprinting, but global interim-confidence state and the hardcoded backchannel list limit robustness. SmartTurn plugin is well-structured. |
| **Barge-In** | Concern — The interruption sequence (abort LLM → stop TTS → flush) is wired correctly on the Critical bus, and the playout clock keeps the assistant interruptible until audio finishes. Missing: false-interruption recovery (pause/resume), and the `interrupt.stt` omission leaves STT state dirty. |
| **TTS Egress** | Concern — Cartesia streams with word timestamps; Deepgram TTS streams but has no per-message context id, creating misattribution risk. Gemini TTS is non-streaming and unsuitable for interactive latency. No TTS RTF gauge. |
| **Reliability** | Solid — WebSocketConnection has quick-failure breaker, replay buffer, keepalive, and bounded backoff. Session store handles reconnect/retain. ProviderFallback is unused. No VAD subprocess isolation (greenfield gap). |
| **Observability** | Good — Turn-boundary events, v2v histograms, per-stage metrics, and VAQI constituents are emitted. Missing: VAQI rollup formula, S2S shadow transcription, and synthetic probes (all Tier-1). |
| **Orchestration** | Not-Ready — The session state machine, bus wiring, and plugin lifecycle are well-designed, but the **per-contextId state leak** across turns is a fundamental flaw for any transport with stable identifiers (telephony). It breaks metrics, barge-in recovery, and TTS/LLM late-packet handling on multi-turn calls. |

---

## Tests

The existing tests cover happy paths and many edge cases well (barge-in latency < 50 ms, short-speech suppression, filler splicing, primary-speaker gating). However, **no test exercises two full turns with the same stable `contextId`** — the existing `allows multiple user turns with the same stable transport contextId` test only asserts `userInputs` length, missing the `vaqi.latency_ms`, `firstTtsAudioFired`, and late-packet guard regressions described above. A dedicated multi-turn characterization test for stable contextIds would have caught the blockers.

---

## What is Genuinely Solid

- **PipelineBus priority routing** (Critical/Main/Background) with backpressure and drop metrics.  
- **TtsPlayoutClock** correctly decouples generation completion from playback completion, keeping barge-in armed until audio is actually heard.  
- **PrimarySpeakerGate** spectral fingerprinting is a thoughtful anti-echo measure without requiring platform AEC.  
- **Deepgram STT finalize timeout + fallback** (`finalizeTimeoutFallback`) with consecutive-timeout breaker shows mature provider-defensive coding.  
- **Twilio transport** correctly validates sequence numbers, timestamps, encodes µ-law, and sends `clear` on interrupt.  
- **Session init/finalize chain** with reverse teardown on failure is clean and testable.
