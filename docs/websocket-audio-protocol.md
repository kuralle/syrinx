# Syrinx Websocket Audio Protocol

Syrinx websocket transports keep provider and client quirks at the transport edge. The engine receives mono PCM16 at the configured kernel sample rate, currently 16 kHz by default, and emits assistant audio as mono PCM16 unless a telephony adapter converts it.

## Browser Websocket

Default path: `/ws`

The server sends a `ready` message after session startup:

```json
{
  "type": "ready",
  "sessionId": "session-...",
  "turnId": "turn-...",
  "resumed": false,
  "resumeWindowMs": 15000,
  "audio": {
    "inputSampleRateHz": 16000,
    "outputSampleRateHz": 16000,
    "encoding": "pcm_s16le",
    "channels": 1,
    "binaryEnvelope": "syrinx.audio.v1",
    "maxInboundMessageBytes": 2097152
  }
}
```

`binaryEnvelope` is present by default for browser websocket assistant-audio output. Inbound clients may use the envelope regardless. Raw outbound PCM can be enabled only by configuring `binaryAudioEnvelope: false` on the server.

`sessionId` is the resumable conversation session id. `turnId` is the default turn context for raw binary audio frames that do not carry an explicit `contextId`.

To resume a browser websocket session after a transient disconnect, reconnect with the same session id before `resumeWindowMs` expires:

```text
ws://host/ws?sessionId=session-...
```

The server keeps the underlying `VoiceAgentSession` alive during the retention window, reuses it on reconnect, and returns `"resumed": true` in `ready`. If the retention window expires without a reconnect, the session is finalized and closed.

The server accepts frames immediately after WebSocket connection and buffers bounded early input until `ready`. Clients should still wait for `ready` before streaming microphone audio so they know the negotiated audio contract and `turnId`, but a fast client sending a small frame after `open` will not silently lose it during session startup. If pending pre-ready input exceeds `maxInboundMessageBytes`, the server closes with code `1009`.

Clients can send JSON audio frames:

```json
{
  "type": "audio",
  "contextId": "turn-123",
  "sampleRateHz": 48000,
  "sequence": 7,
  "audio": "base64-pcm16"
}
```

The server validates strict base64, requires PCM16 payloads to have an even byte length, and resamples from `sampleRateHz` to `inputSampleRateHz` before pushing `user.audio_received` into the engine. A single `contextId` must keep one source `sampleRateHz` for all audio frames on the websocket connection. A new turn/context may declare a different source rate, but changing rates inside the same context is rejected as invalid transport input instead of being silently stitched into one STT stream.

The supplied browser review console sends microphone audio as `syrinx.audio.v1` binary envelopes by default, not JSON base64. JSON audio frames remain supported for scripted clients and compatibility.

Clients can also send raw binary PCM16 at the advertised input sample rate. Raw inbound binary is accepted for low-overhead capture paths, but it cannot carry turn or sample-rate metadata.

## Binary Envelope

Envelope name: `syrinx.audio.v1`

Frame layout:

```text
7 bytes   ASCII magic: SYRXA1\n
4 bytes   little-endian unsigned JSON header length
N bytes   UTF-8 JSON header
M bytes   PCM16 audio payload
```

Header:

```json
{
  "type": "audio",
  "contextId": "turn-123",
  "sampleRateHz": 48000,
  "sequence": 7,
  "encoding": "pcm_s16le",
  "channels": 1,
  "byteLength": 1920,
  "durationMs": 20
}
```

Required invariants:

- `type` must be `audio`.
- `sampleRateHz` must be present as a positive integer.
- `encoding`, when present, must be `pcm_s16le`.
- `channels`, when present, must be `1`.
- `sequence`, when present, must be a non-negative integer.
- `durationMs`, when present, must be a non-negative integer.
- `byteLength`, when present, must exactly match the binary payload length.
- PCM16 payload byte length must be even after envelope decode.
- All audio frames for one `contextId` on a websocket connection must use the same source sample rate.

Enveloped input with missing or malformed timing/format metadata is rejected as a transport error instead of being silently interpreted at the server default sample rate. Raw binary PCM is the supported low-overhead path when a client intentionally wants to rely on the advertised `ready.audio.inputSampleRateHz`.

Assistant audio is sent as the same envelope by default and is still preceded by `tts_chunk` metadata for clients that track lifecycle events in JSON. Server-side `binaryAudioEnvelope: false` restores raw PCM assistant frames for older websocket clients.

## Server Events

Assistant audio lifecycle:

- `tts_chunk`: turn id, sequence, sample rate, encoding, channel count, byte length, and duration for the next binary audio frame.
- Binary frame: enveloped PCM16 audio by default, or raw PCM16 only when `binaryAudioEnvelope: false` is configured.
- `tts_end`: assistant audio is complete for the turn.
- `audio_clear`: queued assistant audio should be discarded because the user interrupted.
- `agent_interrupted`: the agent stream was interrupted by barge-in.

Speech and transcript lifecycle:

- `speech_started`
- `speech_ended`
- `stt_chunk`
- `stt_output`
- `agent_chunk`
- `agent_end`

## Transport Guards

Browser websocket defaults:

- Heartbeat ping interval: 30 seconds.
- Outbound buffered send ceiling: 8 MiB, close code `1013`.
- Inbound message ceiling: 2 MiB, close code `1009`.
- Resume retention window: 15 seconds.

The inbound ceiling applies before JSON parsing, base64 decoding, envelope parsing, or resampling.

The outbound ceiling is checked against `socket.bufferedAmount` plus the byte length of the message about to be sent. A single oversized assistant-audio frame is therefore rejected the same way as accumulated unsent frames instead of being allowed to enter the websocket implementation first.

The supplied browser review console keeps the microphone open after a user gesture. It does not require hold-to-talk. A small browser-side energy gate allocates a new capture context only when speech starts and includes 400 ms of pre-speech audio, which prevents silent phantom turns; server VAD, Smart Turn, and STT finalization still own end-of-turn.

## Smoke Artifact Manifests

Websocket smoke runs write `manifest.json` with `schemaVersion: 2`. The manifest separates byte counts that can otherwise be confused across browser PCM and compressed telephony codecs:

- `inputByteLength` / `outputByteLength`: bytes in the audio format named by the manifest item.
- `inputWireByteLength` / `outputWireByteLength`: bytes carried over the websocket provider/client transport.
- `inputDecodedPcmByteLength` / `outputDecodedPcmByteLength`: PCM16 bytes after decode/normalization for duration checks.
- Per-turn `frameCount`: media frame count observed at the adapter boundary.
- Per-turn carrier latency fields include `firstInboundMediaAfterStart`, `lastInboundMediaAfterStart`, `maxInboundMediaGap`, `firstOutboundMediaAfterFirstInbound`, and `firstOutboundMediaAfterLastInbound`. `maxInboundMediaGap` records the largest observed gap between inbound provider media frames, so clean localhost smokes and jitter/burst smokes can be distinguished. `firstOutboundMediaAfterLastInbound` is the transport-adapter response latency to compare against live carrier timing after the caller's media burst reaches the server.

For raw browser PCM these values are equal. For telephony they intentionally differ: a Twilio PCMU turn can have 1,120 inbound wire bytes but 4,480 normalized engine PCM bytes, while SmartPBX Opus reports compact Opus wire bytes separately from decoded 48 kHz PCM bytes. Durations are computed from decoded PCM semantics, not compressed payload size.

The smoke writer validates the manifest before writing: schema version, turn totals, optional wire/decoded totals, non-negative latency values, and compressed-audio duration math must be coherent. PCMU and Opus artifacts must include decoded PCM provenance, and telephony manifests must include the carrier-relative latency fields, including `maxInboundMediaGap`.

## Twilio Media Streams

Default path: `/twilio`

Live review helper: `pnpm --filter @asyncdot-example/02-hello-voice-headless review:telephony` serves `GET /twilio/twiml` with bidirectional `<Connect><Stream>` TwiML for this path. Set `SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://...` so generated carrier URLs use `wss://`.

Public routing probe:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless probe:telephony-public https://your-public-tls-host.example
```

The probe checks the HTTP setup endpoints, Twilio/Telnyx callback endpoints, and opens Twilio, Telnyx, and SmartPBX-shaped websocket sessions with one valid PCMU media frame. It asserts no websocket extension negotiation, so public deployments preserve the no-compression transport invariant.

Twilio remains provider-specific at the adapter boundary:

- Accept JSON text frames only.
- Validate `start.mediaFormat` as PCMU, 8 kHz, mono.
- Decode inbound `media.payload` from strict base64 PCMU to PCM16.
- Resample inbound audio from 8 kHz to the engine input sample rate.
- Resample assistant PCM16 to 8 kHz, encode PCMU, and send paced 20 ms Twilio `media` frames.
- Send Twilio `mark` after paced outbound audio batches drain and record carrier mark acknowledgements.
- Clear unsent local playout frames and send Twilio `clear` when the engine emits TTS interruption.
- Treat provider `stop`, abrupt websocket disconnect, queued-output overflow, and outbound send-buffer refusal as terminal discard boundaries: late inbound `media` and late carrier `mark` callbacks are ignored, pending marks and locally queued playout are cleared, recorder output is truncated, and no queued or newly generated outbound `media`/`mark`/`clear` messages are emitted after teardown. Discarded playout duration is exposed as `twilio.stop_playout_cleared_ms`, `twilio.disconnect_playout_cleared_ms`, `twilio.overflow_playout_cleared_ms`, or `twilio.send_buffer_playout_cleared_ms`.

Twilio adapter defaults:

- Heartbeat ping interval: 30 seconds.
- Outbound buffered send ceiling: 8 MiB, close code `1013`.
- Inbound message ceiling: 256 KiB, close code `1009`.
- Queued outbound playout ceiling: 30,000 ms, close code `1013`.

The Twilio adapter buffers bounded early `start`/`media` messages that arrive before the `VoiceAgentSession` finishes startup. If pending pre-ready input exceeds the inbound message ceiling, the adapter closes with `1009`.

## Telnyx Media Streaming

Default path: `/telnyx`

Live review helper: `pnpm --filter @asyncdot-example/02-hello-voice-headless review:telephony` serves `GET /telephony/config.json` with `stream_url`, `stream_track`, `stream_bidirectional_mode`, `stream_bidirectional_codec`, and `webhook_url` for this path. Set `SYRINX_TELNYX_BIDIRECTIONAL_CODEC` to match the Telnyx call stream codec.

Telnyx remains provider-specific at the adapter boundary:

- Accept JSON text frames only.
- Validate `start.media_format` as PCMU/8 kHz/mono or L16/16 kHz/mono.
- Decode inbound `media.payload` from strict base64 raw RTP payload into engine PCM16.
- Resample inbound audio into the engine input sample rate.
- Configure `bidirectionalCodec` to match Telnyx `stream_bidirectional_codec` (`PCMU` by default or `L16`), then resample and encode assistant PCM16 accordingly for paced outbound `media` frames.
- Send Telnyx `mark` after paced outbound audio batches drain and record carrier mark acknowledgements.
- Clear unsent local playout frames and send Telnyx `clear` when the engine emits TTS interruption.
- Treat provider `stop`, abrupt websocket disconnect, queued-output overflow, and outbound send-buffer refusal as terminal discard boundaries: late inbound `media` and late carrier `mark` callbacks are ignored, pending marks and locally queued playout are cleared, recorder output is truncated, and no queued or newly generated outbound `media`/`mark`/`clear` messages are emitted after teardown. Discarded playout duration is exposed as `telnyx.stop_playout_cleared_ms`, `telnyx.disconnect_playout_cleared_ms`, `telnyx.overflow_playout_cleared_ms`, or `telnyx.send_buffer_playout_cleared_ms`.

Outbound Telnyx `media`, `mark`, and `clear` commands follow Telnyx's client-to-stream shape and do not include `stream_id`; received mark callbacks may include `stream_id`.

Telnyx adapter defaults:

- Heartbeat ping interval: 30 seconds.
- Outbound buffered send ceiling: 8 MiB, close code `1013`.
- Inbound message ceiling: 256 KiB, close code `1009`.
- Queued outbound playout ceiling: 30,000 ms, close code `1013`.

The Telnyx adapter buffers bounded early `start`/`media` messages that arrive before the `VoiceAgentSession` finishes startup. If pending pre-ready input exceeds the inbound message ceiling, the adapter closes with `1009`.

The live-provider adapter smoke can exercise this Telnyx websocket shape with real Deepgram/Gemini/Cartesia before a carrier call:

```bash
SYRINX_TELEPHONY_PROVIDER=telnyx pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
```

## SmartPBX AI Provider

Default path: `/media-stream`

Live review helper: `pnpm --filter @asyncdot-example/02-hello-voice-headless review:telephony` serves `GET /telephony/config.json` with the SmartPBX websocket URL for this path. Set `SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://...` so generated carrier URLs use `wss://`.

SmartPBX remains provider-specific at the adapter boundary:

- Accept JSON text frames only.
- Receive lifecycle events as `start`, `media`, `dtmf`, and `hangup` (`stop` is accepted for compatibility with the supplied example bridge).
- Validate `start.mediaFormat` as `g711_ulaw`/8 kHz, `pcm16`/24 kHz, or `opus`/48 kHz.
- Decode strict-base64 inbound `media.payload`, treating `pcm16` as little-endian PCM and `opus` as 48 kHz mono Opus frames, then resample into the engine input sample rate.
- Resample and encode assistant PCM16 in the same negotiated SmartPBX format and send paced `media` with required `callId` and `accountId` envelope fields. Opus output is emitted as valid 20 ms frames; partial final PCM is padded and flushed when TTS ends.
- Clear unsent local playout frames on interruption.
- Treat `hangup`, `stop`, abrupt websocket disconnect, queued-output overflow, and outbound send-buffer refusal as terminal discard boundaries: late inbound `media` is ignored, locally queued playout is cleared, recorder output is truncated, and no queued or newly generated outbound `media` is emitted after teardown. Discarded playout duration is exposed as `smartpbx.stop_playout_cleared_ms`, `smartpbx.disconnect_playout_cleared_ms`, `smartpbx.overflow_playout_cleared_ms`, or `smartpbx.send_buffer_playout_cleared_ms`.

The supplied SmartPBX AI Provider protocol document does not define outbound playback `mark` or `clear` events. The adapter therefore does not issue an undocumented clear command on interruption; the engine and recorder still observe the interruption and the local adapter drops unsent frames.

SmartPBX adapter defaults:

- Heartbeat ping interval: 30 seconds.
- Outbound buffered send ceiling: 8 MiB, close code `1013`.
- Inbound message ceiling: 256 KiB, close code `1009`.
- Queued outbound playout ceiling: 30,000 ms, close code `1013`.

The SmartPBX adapter buffers bounded early `start`/`media` messages that arrive before the `VoiceAgentSession` finishes startup. If pending pre-ready input exceeds the inbound message ceiling, the adapter closes with `1009`.

The same live-provider adapter smoke can be run for all telephony websocket shapes:

```bash
SYRINX_TELEPHONY_PROVIDER=twilio pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
SYRINX_TELEPHONY_PROVIDER=telnyx pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
SYRINX_TELEPHONY_PROVIDER=smartpbx pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
```

This smoke uses live Deepgram, Gemini, Cartesia, and the recorder while emulating each provider websocket locally. It waits for paced carrier playout to drain before stop/hangup so recorder artifacts represent audio that reached the carrier boundary.
