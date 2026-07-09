# InteractionPolicy seam + VAP — implementation notes

Task: Plan Desk `Build InteractionPolicy seam + VAP` (308c188f). Branch: `plan/interaction-policy`
(off `beta`). Spec: `docs/rfc-interaction-policy-seam.md`. IC = grok; manager verifies every chunk.

## 0 — Locked intent (restated)

**Done looks like:** the three turn-shaped interaction owners (`endpointingOwner`
provider_stt|smart_turn|timer, `TurnArbiter` barge-in, EOS finalize) are collapsed into ONE
`InteractionPolicy` seam in `packages/core`, behavior-preserving (characterization tests green
unchanged), driving both cascade and realtime paths. Then `Defer`/backchannels/rich-seam land
turn-scoped; a VAP learned controller sits behind the seam; an eval harness is the proof gate.

**Reading picked:** build C1–C4 **turn-scoped now**; build C5 (VAP) turn-scoped only and **defer its
full-duplex no-boundary mode** to backlog B-05; treat C6 (eval harness) as a trailing proof gate.
This is the RFC's own §4 Q4 proposal, confirmed against current code.

## 1 — Premise-check verdict (Explore, 2026-07-09, vs beta HEAD 7adbb32)

Unlike the prior three vNext RFCs, this one is **mostly NOT stale** — the author already accounted
for the IU substrate and correctly gated C5 on the un-landed reshape.

| Chunk | Premise | Verdict | Action |
|-------|---------|---------|--------|
| C1 | 3 owners + TurnArbiter + eos.turn_complete all at cited shape | **INTACT** | build-as-specced |
| C2 | caps shape matches §4.4; full-duplex/backchannel absent | **INTACT** | build-as-specced |
| C3 | InteractionBackchannelPacket absent; BackgroundAudioMixer has setThinking bed | **INTACT** | build-as-specced |
| C4 | stt.partial absent (today: stt.interim/stt.result); additive | **INTACT** | build + also read stt.interim |
| C5 | VAP package pattern exists; full-duplex needs contextId→turn-epoch reshape | **PARTIAL** | build turn-scoped; DEFER full-duplex to B-05 |
| C6 | eval harness, independent | **INTACT** | trailing proof gate |

**Evidence anchors (current beta):**
- `endpointingOwner` union: `packages/core/src/voice-agent-session.ts:164` (config), default
  `provider_stt` `:296`. Three real branches: provider_stt omits `eosAudio` fan-out `:614-629` +
  distinct provider-STT barge-in `:710-716`; smart_turn finalizer gating `:1404-1430`
  (`packages/pipecat-smart-turn` = onnxruntime-node + HF transformers + smart-turn-v3.2 ONNX +
  `semantic-completeness.ts:23`); timer takes the else-branch pushing `eosAudio`.
- `TurnArbiter` `packages/core/src/turn-arbiter.ts:69`; `minInterruptionMs` default 280 at
  `voice-agent-session.ts:301`; executor methods `emitInterruptDetected` `:161`,
  `commitClientInterrupt` `:165`.
- `eos.turn_complete` `packets.ts:203`; factory `packet-factories.ts:122`; session consumer
  `voice-agent-session.ts:553`; reasoner consumer `packages/aisdk/src/index.ts:175→197`.
- IU substrate: `IncrementalUnitId {contextId,iuId,epoch}` `incremental-unit.ts:7-11`; ledger
  bounded LRU 256 `iu-ledger.ts:25`; epoch minted 1:1 per contextId inside aisdk
  `aisdk/src/index.ts:270-287`. **Base `VoicePacket` carries only `contextId`+`timestampMs`
  (`packets.ts:17-23`) — epoch is NOT first-class on packets.** contextId still == turn id
  (telephony `<base>-t<n>` rotation `outbound-playout-pipeline.ts:36-56`).
- Bus: `Route{Critical=0,Main=1,Background=2}` `pipeline-bus.ts:23`; `push` `:35`, `on` `:47`.
- caps: `realtime-adapter.ts:4-17` (inputSampleRateHz, outputSampleRateHz,
  supportsConcurrentToolAudio, supportsTruncate, emitsServerSpeechStarted, supportsNativeResume?).
- Characterization: `packages/core/src/turn-arbiter.characterization.test.ts` (CR-09; drives the
  REAL session; 8-case transition table) — this is the REQ-8 guard.
- `TtsPlayoutClock` `tts-playout-clock.ts:15` (`positionMs` = playedOutMs).
- `BackgroundAudioMixer` `packages/server-websocket/src/background-audio.ts:132`
  (`mix`, `setThinking`, `addBed`, duck 0.5).
- No pre-existing InteractionPolicy/Coordinator/Vap anywhere (clean greenfield).

## 2 — Load-bearing assumptions / decisions

- **A-1 (load-bearing):** C1 is a behavior-preserving reshape — its correctness signal is the
  *unchanged* characterization suite, not a new red test. Red gate = the new coordinator/policy
  tests are red (classes don't exist) while `turn-arbiter.characterization.test.ts` is the green
  discriminative guard that flips if behavior moves.
- **D-1:** `RuleBasedInteractionPolicy` must reproduce provider_stt's *side-effects* (audio
  fan-out difference + provider-STT barge-in), not merely the endpoint decision. This is the one
  place the reshape is more than decision-routing (the C1 risk).
- **D-2:** C4 coordinator subscribes to BOTH the new `stt.partial` and existing `stt.interim` so
  it is useful before Deepgram/Flux emit the rich packet.
- **D-3:** C5 full-duplex/no-boundary mode deferred to B-05 (contextId→turn-epoch reshape not
  landed; confirmed: no first-class epoch on packets). Turn-scoped VAP behind the seam is fine.

## 3 — Progress log
- 2026-07-09: premise-check complete (verdict above); baseline green-gate run; sprint OS next.
