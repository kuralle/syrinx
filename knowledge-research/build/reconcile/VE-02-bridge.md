# VE-02 Bridge — Turn-Taking & Endpointing

## Current state in Syrinx

Syrinx has a working two-layer turn model. Silero VAD emits speech start/activity/end with hangover (`packages/voice-vad-silero/src/index.ts:146`), and Pipecat SmartTurn/semantic EOS listens to VAD + STT to decide when to emit `eos.turn_complete` (`packages/voice-turn-pipecat/src/index.ts:256`, `packages/voice-turn-pipecat/src/index.ts:417`). Deepgram STT can also own finalization by emitting EOS on provider `speech_final`/`from_finalize` (`packages/voice-stt-deepgram/src/index.ts:249`). The session turns EOS into `user.input` (`packages/voice/src/voice-agent-session.ts:606`).

Checklist items already DONE/PARTIAL: semantic/contextual EOT with fallback is DONE for Pipecat mode; VAD hysteresis is PARTIAL because it is a boolean+silence hangover, not an explicit four-state machine; single-owner turn-taking is PARTIAL because it is plugin config, not a session-level invariant.

## Gap (what's actually missing)

VE-02 should close three exact gaps: explicit VAD states (QUIET/STARTING/SPEAKING/STOPPING), a session-level endpoint owner contract that prevents Deepgram and Pipecat from both finalizing the same turn, and latency-budget accounting that treats VAD stop + endpointing delay + STT final latency as one number.

## Implementation approach

Touch:

- `packages/voice/src/packets.ts` for optional `TurnBoundaryOwner`/mode metadata if needed.
- `packages/voice/src/voice-agent-session.ts` for a session-level `endpointingOwner` config and conditional audio fan-out to EOS.
- `packages/voice-vad-silero/src/index.ts` for explicit state enum and state-transition metrics.
- `packages/voice-stt-deepgram/src/index.ts` and `packages/voice-turn-pipecat/src/index.ts` for owner-aware EOS behavior.
- `packages/voice-server-websocket/src/turn-metrics.ts` for EOU budget fields.

Pseudocode:

```ts
type EndpointOwner = "provider_stt" | "smart_turn" | "timer";
type VadState = "quiet" | "starting" | "speaking" | "stopping";

interface TurnTakingConfig {
  readonly endpointOwner: EndpointOwner;
  readonly vadStartMs: number;
  readonly vadStopMs: number;
  readonly endpointDelayMs: number;
}

private handleUserAudio(pkt: UserAudioReceivedPacket): void {
  const packets = [
    make.recordUserAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
    make.vadAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
    make.sttAudio(pkt.contextId, pkt.timestampMs, pkt.audio),
  ];
  if (this.endpointOwner !== "provider_stt") {
    packets.push(make.eosAudio(pkt.contextId, pkt.timestampMs, pkt.audio));
  }
  this.bus.push(Route.Main, ...packets);
}

function onProviderFinal(pkt: SttResultPacket): void {
  if (endpointOwner === "provider_stt") emitEos(pkt);
  else emitSttResultOnly(pkt);
}
```

For VAD, replace `speaking: boolean` with explicit state and two counters. `STARTING` requires sustained speech before emitting `vad.speech_started`; `STOPPING` requires sustained silence before `vad.speech_ended`. Emit metrics for `vad.start_delay_ms`, `vad.stop_hangover_ms`, and `endpoint.owner`.

## Acceptance criteria (narrowed to the real gap)

- [ ] Session config selects exactly one endpoint owner: provider STT, SmartTurn, or timer fallback.
- [ ] Tests prove provider-owned mode never routes to Pipecat EOS and SmartTurn-owned mode never lets provider finals emit EOS.
- [ ] Silero VAD exposes explicit four-state transitions and tests cover noise flapping around start/stop thresholds.
- [ ] Turn metrics include VAD stop hangover, endpointing delay, STT final delay, and their sum.
- [ ] Existing SmartTurn semantic tests still pass with owner-aware routing.

## Risks & edge cases

Changing fan-out can break plugins that assume all audio always reaches EOS. Keep the default owner aligned with existing examples before changing production config. Provider-owned EOT must still emit VAD events for barge-in and metrics, but not EOS. If Deepgram Finalize times out, SmartTurn mode should not accidentally promote cached interim text unless the existing opt-in fallback is enabled (`packages/voice-stt-deepgram/src/index.ts:307`).

## WBS for ICs (§8)

| ID | Sub-task | Files | Acceptance | Depends on |
|---|---|---|---|---|
| VE-02.1 | Add endpoint owner config | `packages/voice/src/voice-agent-session.ts` | Config defaults documented; unsupported owner throws | VE-01 |
| VE-02.2 | Make EOS fan-out owner-aware | `voice-agent-session.ts`, `voice-stt-deepgram`, `voice-turn-pipecat` | Tests prove one `eos.turn_complete` per user turn | VE-02.1 |
| VE-02.3 | Refactor Silero to four-state VAD | `packages/voice-vad-silero/src/index.ts` | Unit tests cover QUIET->STARTING->SPEAKING->STOPPING | none |
| VE-02.4 | Add EOU budget metrics | `packages/voice-server-websocket/src/turn-metrics.ts` | Metrics message separates VAD hangover, endpoint delay, STT final delay | VE-02.2 |
| VE-02.5 | Update provider tests for owner modes | STT/EOS tests | No duplicate finalization under mixed plugin registration | VE-02.2 |
