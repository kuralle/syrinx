# VE-01 Bridge — End-to-End Audio Round Trip

## Current state in Syrinx

Syrinx already has the tracer-bullet spine. Browser and telephony transports normalize inbound audio to `user.audio_received` (`packages/voice-server-websocket/src/index.ts:615`, `packages/voice-server-websocket/src/twilio.ts:307`), and `VoiceAgentSession` fans it to VAD, STT, EOS, and recorder packets (`packages/voice/src/voice-agent-session.ts:472`). Deepgram STT is session-long and streams audio (`packages/voice-stt-deepgram/src/index.ts:257` `sendAudio`) with KeepAlive (`packages/voice-stt-deepgram/src/index.ts:131`) and provider Finalize (`packages/voice-stt-deepgram/src/index.ts:272`). The AI SDK bridge streams LLM deltas concurrently (`packages/voice-bridge-aisdk/src/index.ts:91`), the session sentence-buffers deltas into `tts.text` (`packages/voice/src/voice-agent-session.ts:705`), Cartesia/Deepgram TTS stream audio (`packages/voice-tts-cartesia/src/index.ts:100`, `packages/voice-tts-deepgram/src/index.ts:110`), and outbound playout chunks/paces audio (`packages/voice-server-websocket/src/outbound-playout-pipeline.ts:91`, `packages/voice-server-websocket/src/paced-playout.ts:35`).

Checklist items already DONE or mostly done: internal PCM16/mono and µ-law edge isolation, persistent Deepgram STT, stateful resampling, small outbound chunks, sentence aggregation, and streaming TTS for Cartesia/Deepgram. **Two pieces the gap section previously over-stated as net-new ALREADY exist:** (1) structural audio-payload validation — `validateSyrinxAudioEnvelope` already throws on channels≠1, empty Opus, and odd-length PCM16 (`packages/voice/src/audio-envelope.ts:71-111`); the pseudocode below duplicates it, so VE-01.1 is *reuse/extend*, not net-new. (2) ready-frame capability negotiation — the ready frame already emits `inputSampleRateHz`/`outputSampleRateHz`/`encoding`/`supportedInputCodecs`/`channels` (`packages/voice-server-websocket/src/index.ts:295-312`); only **target frame duration** + a no-silent-sample-rate-switch test are genuinely missing.

## Gap (what's actually missing)

The real VE-01 gap is not "wire the pipe"; it is to make the round trip an explicit, measured contract: central audio-format handshakes/assertions, a true 24 kHz default TTS egress or documented per-provider deviation, bounded output buffering in the 100-200 ms band, production browser media strategy decision (WebSocket+Opus now vs WebRTC later), and a passing live tracer-bullet baseline that does not look like `baseline-v2.json`'s missing STT/TTS result (`baseline-v2.json:1`).

## Implementation approach

Touch:

- `packages/voice/src/packets.ts` and `packages/voice/src/audio-envelope.ts` for reusable `AudioFormat` metadata and validation.
- `packages/voice-server-websocket/src/index.ts` for ready-frame capability negotiation and output-buffer defaults.
- `packages/voice-stt-deepgram/src/index.ts`, `packages/voice-stt-google/src/index.ts`, `packages/voice-tts-cartesia/src/index.ts`, `packages/voice-tts-deepgram/src/index.ts`, `packages/voice-tts-gemini/src/index.ts` for declared-vs-actual format validation.
- `scripts/run-streaming-cascade.ts` or a new `scripts/run-tracer-bullet.ts` for live v2v baseline capture.

Pseudocode:

```ts
export interface AudioFormat {
  readonly encoding: "pcm_s16le" | "mulaw" | "opus";
  readonly sampleRateHz: number;
  readonly channels: 1;
  readonly frameDurationMs?: number;
}

export function assertAudioPayload(format: AudioFormat, bytes: Uint8Array): void {
  if (format.channels !== 1) throw new Error("audio must be mono");
  if (format.encoding === "pcm_s16le" && bytes.byteLength % 2 !== 0) {
    throw new Error("pcm_s16le payload must be 16-bit aligned");
  }
  if (format.encoding === "opus" && bytes.byteLength === 0) {
    throw new Error("opus frame must be non-empty");
  }
}

function connectDeepgramStt(format: AudioFormat): URL {
  assertAudioPayload(format, new Uint8Array(0)); // validates structural format; per-frame validates bytes.
  if (format.encoding !== "pcm_s16le") throw new Error("Deepgram STT adapter expects PCM unless passthrough mode is enabled");
  return withParams(endpointUrl, {
    encoding: "linear16",
    sample_rate: String(format.sampleRateHz),
    channels: "1",
  });
}
```

Set `maxQueuedOutputAudioMs` for browser/telephony defaults to a design-band value for interactive sessions, e.g. 200 ms with an override for non-interruptible playback. Keep the existing `PacedPlayoutQueue` overflow behavior, but make long queues opt-in.

The browser WebRTC decision should be explicit: VE-01 can ship with WebSocket+Opus if documented as "current client media mode"; WebRTC/FEC is moved to VE-08 unless the product requires native WebRTC before tracer-bullet acceptance.

## Acceptance criteria (narrowed to the real gap)

- [ ] Every STT/TTS adapter declares an `AudioFormat` and validates outgoing/incoming bytes against it at connect/send boundaries.
- [ ] Browser/server ready frames already include input/output sample rate, encoding, channels, codecs (`index.ts:295-312`); **add the missing `target frame duration` field**; tests assert clients cannot silently switch sample rate inside a context.
- [ ] Interactive outbound playout buffer defaults are within 100-200 ms unless the caller explicitly opts into a larger queue.
- [ ] A live tracer-bullet script records user audio in, STT final, first LLM delta, first TTS byte, first playout, and v2v for at least three turns.
- [ ] `baseline-v2.json` is replaced or superseded by an artifact showing non-empty transcript and non-empty TTS chunks for all tracer turns.

## Risks & edge cases

Browser `AudioContext` sample rates can be 44.1/48 kHz, so a strict server-side 16 kHz contract must preserve the existing client resampling path. Lowering playout queue defaults can expose provider burstiness; keep overflow metrics and let non-interruptible modes opt into larger queues. Gemini TTS remains non-streaming by design; either mark it degraded for interactive VE-01 or exclude it from the tracer-bullet default.

## WBS for ICs (§8)

| ID | Sub-task | Files | Acceptance | Depends on |
|---|---|---|---|---|
| VE-01.1 | **Reuse/extend** existing `validateSyrinxAudioEnvelope` + surface an `AudioFormat` type (do NOT duplicate the channel/PCM/Opus checks — they exist at `audio-envelope.ts:71-111`) | `packages/voice/src/packets.ts`, `packages/voice/src/audio-envelope.ts`, tests | Existing structural checks reused; only the typed `AudioFormat` surface is new | none |
| VE-01.2 | Apply format assertions in STT/TTS adapters | `packages/voice-stt-*`, `packages/voice-tts-*` | Adapter tests assert declared format equals sent/received bytes | VE-01.1 |
| VE-01.3 | Tighten interactive playout defaults | `packages/voice-server-websocket/src/index.ts`, telephony servers | Default queue is 100-200 ms; long queue requires explicit option | none |
| VE-01.4 | Build live tracer-bullet script/artifact | `scripts/run-tracer-bullet.ts`, `baseline-v2.json` replacement | 3+ live turns have transcript, reply, TTS chunks, and v2v | VE-01.2 |
| VE-01.5 | Document current client media mode | `PROVIDER-TESTING.md` or build docs | WebSocket+Opus vs future WebRTC is explicit; no hidden WebRTC acceptance in VE-01 | none |
