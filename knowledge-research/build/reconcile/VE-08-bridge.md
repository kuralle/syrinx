# VE-08 Bridge — Tier-1 Hardening

## Current state in Syrinx

Some Tier-1 primitives are present but incomplete. Semantic completeness can classify backchannels (`packages/voice-turn-pipecat/src/semantic-completeness.ts:51`), latency filler can emit a short connective (`packages/voice/src/latency-filler.ts:41`), Cartesia emits word timestamps (`packages/voice-tts-cartesia/src/index.ts:243`), transcripts and user input carry language fields (`packages/voice/src/packets.ts:162`, `packages/voice/src/packets.ts:201`), and packet types reserve denoiser stages (`packages/voice/src/packets.ts:120`). There is no eager-EOT/preemptive generation, denoiser plugin, VAD benchmark, pronunciation controls, false-interruption resume, WebRTC/FEC verification, or automatic language-triggered voice switching.

Checklist Tier-1 state: backchannel classification PARTIAL, multilingual metadata PARTIAL, word timestamps PARTIAL, denoise MISSING, eager EOT MISSING, VAD benchmarking MISSING, pronunciation MISSING, Opus FEC MISSING.

## Gap (what's actually missing)

VE-08 should split hardening into independently shippable child slices instead of one broad ticket: preemptive generation, denoise/AEC, interruption classifier/resume, multilingual metadata and TTS voice switching handoff, VAD benchmarks, pronunciation controls, and WebRTC/Opus FEC verification.

## Implementation approach

Touch varies by child slice:

- Preemptive generation: `packages/voice/src/packets.ts`, `voice-agent-session.ts`, `voice-bridge-aisdk/src/index.ts`.
- Denoise/AEC: new denoiser plugin plus session fan-out order before VAD/STT.
- Backchannel/resume: `turn-arbiter.ts`, `semantic-completeness.ts`, playout queue.
- Multilingual/pronunciation: STT packets, AI bridge, TTS plugins.
- VAD benchmark: scripts/tests around `voice-vad-silero` and candidate providers.

Preemptive generation pseudocode:

```ts
interface PreemptiveHandle {
  readonly contextId: string;
  readonly transcript: string;
  readonly ctxHash: string;
  readonly toolsHash: string;
  readonly abort: AbortController;
}

function onEagerEot(pkt: EagerEotPacket): void {
  const handle = bridge.startPreemptive({
    transcript: pkt.text,
    scheduleSpeech: false,
  });
  preemptive.set(pkt.contextId, handle);
}

function onFinalEot(pkt: EndOfSpeechPacket): void {
  const handle = preemptive.get(pkt.contextId);
  if (handle && handle.transcript === pkt.text && handle.ctxHash === ctxHash()) {
    bridge.commitPreemptive(handle);
  } else {
    handle?.abort.abort();
    bus.push(Route.Main, make.userInput(pkt.contextId, Date.now(), pkt.text, language));
  }
}
```

Denoise routing should be `user.audio_received -> denoise.audio -> denoise.result -> vad.audio/stt.audio`, with a config bypass when disabled.

## Acceptance criteria (narrowed to the real gap)

- [ ] Child tickets/RFCs are created for each Tier-1 slice with isolated acceptance criteria.
- [ ] Preemptive generation starts on eager signal, never emits audio before final validation, and scraps on transcript/context/tool mismatch.
- [ ] Denoiser plugin can be inserted before VAD/STT and bypassed with no behavior change.
- [ ] Backchannel classifier suppresses active interruptions and supports false-interruption resume where playout can pause.
- [ ] Language metadata includes language code and confidence, and TTS voice selection receives it.
- [ ] VAD benchmark compares Silero against at least one alternative on target hardware.
- [ ] WebRTC/FEC item is either implemented or explicitly deferred if Syrinx keeps WebSocket+Opus.

## Risks & edge cases

Preemptive generation burns LLM tokens; require VE-05 metrics before enabling by default. Denoising can add latency and damage VAD if frame sizes/rates mismatch. Automatic language switching can introduce audible gaps if TTS sockets must reconnect. Backchannel suppression must not suppress genuine short interruptions like "stop".

## WBS for ICs (§8)

| ID | Sub-task | Files | Acceptance | Depends on |
|---|---|---|---|---|
| VE-08.1 | RFC child slice for preemptive generation | build docs, AI bridge/session | RFC approved with validation/scrap contract | VE-02/VE-05 |
| VE-08.2 | Denoiser plugin insertion | `packets.ts`, `voice-agent-session.ts`, new plugin | Disabled denoise is no-op; enabled path feeds VAD/STT only denoised audio | VE-01 |
| VE-08.3 | Backchannel/resume hardening | `turn-arbiter.ts`, playout files | Backchannels suppress interrupt; false resume works where pausable | VE-03 |
| VE-08.4 | Multilingual metadata propagation | STT/session/TTS plugins | Language code+confidence reaches TTS voice selector | VE-05 |
| VE-08.5 | VAD benchmark harness | `packages/voice-vad-silero`, scripts | Benchmark report on target hardware | VE-02 |
| VE-08.6 | Pronunciation controls | TTS plugins/session config | Dictionary entries alter synthesized text/API params in tests | VE-01 |
| VE-08.7 | Opus/WebRTC FEC decision | transport packages/docs | Either WebRTC FEC verified or formal deferral documented | VE-01 |
