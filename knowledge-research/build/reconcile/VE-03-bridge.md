# VE-03 Bridge — Barge-In / Interruption

## Current state in Syrinx

Barge-in has a real skeleton. The bus has a Critical route that drains before Main (`packages/voice/src/pipeline-bus.ts:23`, `packages/voice/src/pipeline-bus.ts:276`). During assistant playout, VAD speech starts are routed through `TurnArbiter` (`packages/voice/src/voice-agent-session.ts:577`; `:571` is the `latestActiveTtsContextId()` gate), which gates sustained speech and primary-speaker match (`packages/voice/src/turn-arbiter.ts:150` `tryCommit`) before emitting `interrupt.detected` (`packages/voice/src/turn-arbiter.ts:183`). The session then marks the context interrupted, truncates assistant recording, and pushes `interrupt.tts` plus `interrupt.llm` (`packages/voice/src/voice-agent-session.ts:848`). Outbound playout clears queued audio on `interrupt.tts` (`packages/voice-server-websocket/src/outbound-playout-pipeline.ts:83`), Cartesia/Deepgram TTS cancel provider synthesis (`packages/voice-tts-cartesia/src/index.ts:188`, `packages/voice-tts-deepgram/src/index.ts:145`), and AI SDK history can be rewritten to the spoken prefix (`packages/voice-bridge-aisdk/src/index.ts:333`).

Checklist items already DONE/PARTIAL: full-duplex input is DONE, high-priority lane is DONE, logic+media cancel is PARTIAL, spoken-prefix history is PARTIAL, and interruption gating is PARTIAL.

## Gap (what's actually missing)

The open gap is verification and precision: interruption does not emit onset-to-media-silent/onset-to-logic-cancel metrics, does not include STT confidence/backchannel classification in the active interruption gate, does not support pause/resume for false interruptions, and does not have a selective frame taxonomy for interruptible vs required control frames.

## Implementation approach

Touch:

- `packages/voice/src/packets.ts` for `interrupt.started`, `interrupt.media_silent`, and maybe `interrupt.false_positive` packets/metrics.
- `packages/voice/src/turn-arbiter.ts` to incorporate STT/backchannel evidence and emit suppression metrics.
- `packages/voice-server-websocket/src/outbound-playout-pipeline.ts` and `paced-playout.ts` for selective clear and optional pause/resume.
- `packages/voice-bridge-aisdk/src/index.ts` to consume a precise playout progress signal for browser too.
- Provider TTS plugins only if cancel acknowledgement is needed for logic-cancel measurement.

Pseudocode:

```ts
interface InterruptionGateState {
  readonly startedAtMs: number;
  vadConfidence: number;
  latestInterimText: string;
  semanticLabel?: "backchannel" | "complete" | "incomplete";
}

function shouldCommitInterruption(state: InterruptionGateState, nowMs: number): boolean {
  if (nowMs - state.startedAtMs < minInterruptionMs) return false;
  if (state.vadConfidence < vadInterruptThreshold) return false;
  if (state.semanticLabel === "backchannel") return false;
  return primarySpeakerGate.shouldCommitBargeIn();
}

function onInterruptDetected(pkt: InterruptionDetectedPacket): void {
  metric(pkt.contextId, "interrupt.onset_ms", String(pkt.timestampMs));
  bus.push(Route.Critical, make.interruptTts(pkt.contextId, Date.now()));
  bus.push(Route.Critical, make.interruptLlm(pkt.contextId, Date.now()));
}

function onPlayoutCleared(contextId: string, onsetMs: number): void {
  metric(contextId, "interrupt.media_silent_ms", String(Date.now() - onsetMs));
}
```

For selective flush, extend `PacedPlayoutFrame` with `interruptible?: boolean` and make `clear({interruptibleOnly:true})` retain control frames. For browser spoken-prefix precision, emit `tts.playout_progress` from `AudioJitterBuffer` scheduling or use server-side paced frames as authoritative for WS downlink.

## Acceptance criteria (narrowed to the real gap)

- [ ] Barge-in records `interrupt.onset_to_media_silent_ms` and `interrupt.onset_to_logic_cancel_ms` for committed interruptions.
- [ ] Interruption gate suppresses short speech, low-confidence speech, non-primary speaker/echo, and STT-classified backchannels with distinct metrics.
- [ ] Playout clear supports retaining uninterruptible control frames; tests prove terminal/end/control frames are not lost.
- [ ] AI SDK history truncation uses word timestamps + playout progress on browser and telephony paths, not just telephony.
- [ ] False-interruption resume is implemented where output can pause; destructive flush remains the fallback for non-pausable outputs.

## Risks & edge cases

Waiting for STT text before committing interruption can hurt the <100 ms target. Use STT/backchannel evidence as a fast suppressor when already available, not as a mandatory slow dependency. Browser AEC is unresolved; primary-speaker spectral gating is a weak heuristic and should not be treated as robust speaker verification. Selective frame retention must not replay speech after an interrupt.

## WBS for ICs (§8)

| ID | Sub-task | Files | Acceptance | Depends on |
|---|---|---|---|---|
| VE-03.1 | Add interruption latency probes | `voice-agent-session.ts`, `outbound-playout-pipeline.ts`, tests | Metrics for onset-to-silent and onset-to-cancel emitted on committed interrupt | VE-02 |
| VE-03.2 | Integrate backchannel/STT evidence in gate | `turn-arbiter.ts`, `voice-turn-pipecat` | Backchannel utterance during agent speech suppresses interrupt | VE-02 |
| VE-03.3 | Add selective playout clear | `paced-playout.ts`, `outbound-playout-pipeline.ts` | Interrupt clears speech frames and preserves uninterruptible controls | VE-03.1 |
| VE-03.4 | Browser playout progress for spoken prefix | `voice-client-browser/src/audio.ts`, `voice-server-websocket/src/index.ts` | Browser barge-in history truncates to actually played words when timestamps exist | VE-03.1 |
| VE-03.5 | False-interruption pause/resume | playout/TTS transport files | False trigger resumes audio within timeout on pausable transports | VE-03.3 |
