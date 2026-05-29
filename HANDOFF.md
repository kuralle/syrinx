# Syrinx Voice Engine - Session Handoff

**Date:** 2026-05-28
**Working dir:** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`
**Current focus:** v2 websocket-first speech engine reliability, browser transport hardening, then sequential telephony websocket adapters.

## Current State

The v2 kernel is the active path. Do not preserve v1 compatibility unless explicitly requested.

The production websocket cascade now runs:

```text
16 kHz websocket PCM user audio
  -> Silero VAD
  -> Pipecat Smart Turn v3 local ONNX endpoint classifier
  -> Deepgram STT with provider Finalize control
  -> AI SDK Gemini agent + tools
  -> Cartesia TTS for interactive review or Gemini TTS for fixture longform
  -> websocket PCM / WAV artifacts
```

Key implementation points:

- `@asyncdot/voice-turn-pipecat` now bundles Pipecat `smart-turn-v3.2-cpu.onnx` and runs local Whisper-feature ONNX inference with `onnxruntime-node`.
- The workspace pins the VAD/Smart Turn native runtime graph to one `onnxruntime-node@1.24.3` version and adds a pnpm package extension for HuggingFace's undeclared `onnxruntime-common` import. This avoids Linux container library collisions between ONNX 1.24 and 1.26 during VAD/Pipecat startup.
- Smart Turn emits `stt.finalize` only after it approves a boundary; Deepgram sends the provider `Finalize` control frame, waits for either provider `speech_final` or provider `from_finalize`, then releases the buffered provider-final transcript without language-specific local rewriting.
- The websocket transport now advertises its PCM contract on `ready`, accepts `sampleRateHz` on JSON or enveloped binary audio frames, normalizes PCM16 input to the engine sample rate, rejects malformed odd-byte PCM, and emits `tts_chunk` metadata before each binary assistant-audio frame.
- Browser websocket input now enforces a turn-scoped audio-rate invariant: every audio frame for one `contextId` on a websocket connection must use the same source sample rate. A new context may declare a different rate, but a mid-context `sampleRateHz` change is rejected as invalid transport input instead of being silently resampled into the same STT stream.
- Browser websocket input now treats optional JSON/enveloped `sequence` values as transport evidence. Duplicate or regressing input sequence values are rejected before the frame reaches VAD/STT, while forward gaps are accepted but recorded as `websocket.audio_sequence_gap` metrics with expected, actual, and missed frame counts.
- The websocket server now attaches its input path immediately on socket connection and buffers bounded early client frames until `ready`. This protects against browser/client SDKs that send audio right after WebSocket `open` while the `VoiceAgentSession` is still starting.
- Non-telephony websocket assistant audio now uses the `syrinx.audio.v1` binary envelope by default, carrying turn id, sample rate, sequence, encoding, channel count, duration, and byte length in-frame. Inbound binary clients may use the same envelope; enveloped audio requires a valid positive-integer `sampleRateHz` and rejects malformed numeric metadata instead of silently defaulting to the server sample rate. Raw inbound PCM16 is still accepted at the advertised input sample rate. Raw outbound PCM is available only by explicitly setting `binaryAudioEnvelope: false`.
- Browser and telephony websocket endpoints now attach their input handlers immediately on socket connection and buffer bounded early frames until the session is ready, so browser audio and carrier `start`/first `media` frames are not lost during session startup. They also run heartbeat pings, close slow consumers with code `1013` before the outbound assistant-audio buffer grows unbounded, count the next outbound frame against the send-buffer ceiling before sending so one oversized frame cannot bypass backpressure, close oversized inbound messages with code `1009`, and reject malformed base64 media before it reaches the engine. Defaults: 30 s heartbeat, 8 MiB buffered-send ceiling, 2 MiB browser inbound ceiling, 256 KiB telephony inbound ceiling.
- Websocket servers now use explicit `noServer` upgrade routing and disable websocket compression. This prevents shared HTTP servers with `/twilio`, `/telnyx`, and `/media-stream` adapters from racing independent `server + path` upgrade listeners and corrupting public websocket handshakes. Package coverage includes all three carrier adapters mounted on the same HTTP server, plus compression-negotiation assertions.
- Browser websocket sessions now expose a stable `sessionId` in `ready` and can resume the same in-memory `VoiceAgentSession` with `?sessionId=...` during a 15 s default retention window. Stale socket listeners are disposed on disconnect so resumed sessions do not double-send events.
- Websocket clients receive VAD `speech_started` / `speech_ended`, `audio_clear`, and `agent_interrupted`; the browser review console flushes queued output audio on interruption.
- The browser review console sends microphone frames as `syrinx.audio.v1` binary envelopes, decodes default enveloped assistant audio before playback/artifact accounting, and still uses `tts_chunk` as lifecycle sideband for UI timing. Fixture websocket smoke harnesses continue to use JSON audio frames for deterministic scripted input.
- `@asyncdot/voice-client-browser` now has tested browser audio utilities for 48 kHz and 44.1 kHz capture down to 16 kHz PCM16, including Float32 clamping, turn-scoped JSON frame encoding for compatibility, and default `sendFloat32Audio()` binary envelope transport.
- The headless example now includes a Chrome runtime capture smoke against the real browser review console. It uses `getUserMedia`, `AudioContext`, fake microphone input, 48 kHz -> 16 kHz browser-side encoding, and a real websocket server to verify every microphone frame is sent as an envelope, received as decoded PCM, and kept to one gated capture context.
- `@asyncdot/voice-recorder` now waits for pending file writes on close, consumes recording packets from the bus audit stream so critical truncation survives blocked main dispatch during shutdown, supports assistant-audio truncation on barge-in and terminal transport playout discard, lifts listener caps on owned write streams during high-volume recording, and writes `manifest.json` with sample rates, byte counts, chunk counts, truncation count, and artifact paths. The session emits `record.assistant_audio` with `truncate: true` before TTS/LLM interruption, and telephony adapters emit the same correction when queued assistant audio is discarded, mirroring Rapida/LiveKit-style recorder behavior so queued but unheard assistant audio is not preserved as if it played.
- `@asyncdot/voice-stt-deepgram` follows provider semantics: session-long websocket, provider `Finalize`, `is_final` transcript buffering, text-frame `KeepAlive` during idle/post-turn playout, and `CloseStream` only during session shutdown. It releases only after Pipecat-approved finalization plus provider `speech_final`/`from_finalize`, uses a cached fallback only if no provider final arrives after a finalize request, does not reconstruct provider finals with English token heuristics, and converts malformed provider JSON, Deepgram `type:"Error"`/`err_*` frames, failed audio sends, and unexpected websocket close frames into structured `stt.error` packets. Deepgram `NET-*` close reasons map to recoverable connection failures; `DATA-*` close reasons map to fatal input failures. Provider-boundary audio byte metrics now advance only after the Deepgram websocket accepts the frame for send.
- `@asyncdot/voice` sentence-buffers streamed LLM deltas before speech. Completed sentences are sent to TTS as soon as they arrive; any remaining provider-completed tail is flushed at `llm.done` and recorded as `tts.final_tail_flushed`. This follows the production pattern in LiveKit/Pipecat where LLM text remains streamable but TTS consumers coalesce text before synthesis and flush remaining text at response end.
- `@asyncdot/voice` now treats interruption as a terminal generation boundary for that context. Late LLM deltas, late LLM done events, and late TTS audio for an interrupted context are ignored and recorded as metrics instead of reopening speech after barge-in. Browser, Twilio, Telnyx, and SmartPBX websocket transports also suppress late `tts.audio`/`tts.end` for interrupted contexts so stale provider/plugin output cannot restart playout or emit terminal marks after a clear. This closes the race where provider cancellation is asynchronous and stale generation can arrive after the engine has already yielded to the caller.
- `@asyncdot/voice-tts-cartesia` now follows Cartesia's current websocket context contract: the API key is sent in the `X-API-Key` header instead of the URL, each utterance keeps one `context_id`, `tts.done` finishes the context with an empty terminal continuation, and `interrupt.tts` sends documented `{ context_id, cancel: true }` requests for active contexts. Provider `type:"error"` frames, malformed provider JSON, websocket errors, provider closes while contexts are active, and failed initial or terminal text sends are converted into context-scoped `tts.error` packets instead of throwing out of the websocket listener or leaving a hung TTS context. Contexts are tracked as active only while there is evidence that provider sends succeeded, so `tts.done` does not flush text that never reached Cartesia and later interruptions do not cancel contexts whose terminal flush failed. Cartesia also suppresses late `data`/`done` frames for cancelled contexts so stale provider audio cannot leak back onto the bus after barge-in. Legacy helper scripts that call Cartesia directly now use header auth as well.
- `@asyncdot/voice-bridge-aisdk` records AI SDK provider finish reasons and fails the turn instead of emitting `llm.done` when Gemini ends with `length`, `content-filter`, `error`, `tool-calls`, `other`, or no finish metadata. The university profile uses a larger voice token budget (`1024` interactive, `1400` longform) and defaults Deepgram to `nova-3`, with `SYRINX_DEEPGRAM_MODEL` and `SYRINX_DEEPGRAM_LANGUAGE` still configurable.
- `VoiceAgentSession.close()` now shares one in-flight finalization promise across concurrent close callers. This prevents telephony `stop`/disconnect, harness cleanup, and server shutdown from finalizing plugins concurrently; recorder manifests are no longer vulnerable to partial writes or duplicate truncation during racing closes.
- `@asyncdot/voice-server-websocket` now exposes a Twilio Media Streams websocket endpoint. It validates Twilio `start.mediaFormat`, validates top-level `sequenceNumber` continuity when present, decodes inbound PCMU/8 kHz media to engine PCM16/16 kHz, validates inbound `media.chunk` continuity when present, emits `twilio.sequence_gap` and `twilio.media_chunk_gap` metrics for forward gaps, rejects duplicate/regressing sequence/chunk values before they reach VAD/STT, emits assistant PCM back as paced 20 ms Twilio PCMU `media` frames, sends Twilio `mark` only after the paced audio batch drains, records inbound carrier `mark` acknowledgements as metrics, maps engine TTS interruptions to local queue clear plus Twilio `clear`, and treats provider `stop`, abrupt websocket disconnect, outbound playout overflow, and outbound send-buffer refusal as terminal discard boundaries by cancelling already queued playout, truncating recorder output, and recording `twilio.stop_playout_cleared_ms`, `twilio.disconnect_playout_cleared_ms`, `twilio.overflow_playout_cleared_ms`, or `twilio.send_buffer_playout_cleared_ms`. Outbound Twilio `mark_sent` and `clear_sent` metrics are emitted only when the corresponding JSON control frame actually enters the websocket send path. Terminal Twilio end marks are kept pending until all prior playback marks are acknowledged, so graceful teardown can wait for provider-confirmed playout completion instead of byte counts alone.
- `@asyncdot/voice-server-websocket` now also exposes a Telnyx-style Media Streaming websocket endpoint. It validates Telnyx `start.media_format`, validates top-level `sequence_number` continuity when present, supports inbound PCMU/8 kHz and L16/16 kHz mono payloads, validates inbound `media.chunk` continuity when present, emits `telnyx.sequence_gap` and `telnyx.media_chunk_gap` metrics for forward gaps, rejects duplicate/regressing sequence/chunk values before they reach VAD/STT, normalizes inbound media to engine PCM16, emits outbound paced `media` frames using the configured `stream_bidirectional_codec` mirror (`bidirectionalCodec`), sends `mark` after paced drain, records mark acknowledgements, maps interruption to local queue clear plus Telnyx `clear`, and treats provider `stop`, abrupt websocket disconnect, outbound playout overflow, and outbound send-buffer refusal as terminal discard boundaries by cancelling queued playout, truncating recorder output, and recording the matching `telnyx.*_playout_cleared_ms` metric. Outbound Telnyx `mark_sent` and `clear_sent` metrics are emitted only when the corresponding JSON control frame actually enters the websocket send path. Terminal Telnyx end marks are kept pending until all prior playback marks are acknowledged, matching the Twilio graceful-drain behavior.
- `@asyncdot/voice-server-websocket` now exposes a SmartPBX AI Provider endpoint at `/media-stream`. It validates SmartPBX `start.mediaFormat`, supports `g711_ulaw`/8 kHz, little-endian `pcm16`/24 kHz, and Opus/48 kHz payloads, normalizes inbound audio to engine PCM16, sends paced outbound `media` with the required `callId` and `accountId`, clears unsent local playout on interruption, and treats `hangup`/`stop`, abrupt websocket disconnect, outbound playout overflow, and outbound send-buffer refusal as terminal discard boundaries by cancelling queued local playout, truncating recorder output, and recording the matching `smartpbx.*_playout_cleared_ms` metric. Opus output is encoded as valid 20 ms frames and partial final PCM is flushed on `tts.end`. The documented SmartPBX contract does not define playback `mark` or `clear`, so no undocumented provider command is emitted. Instead, the adapter emits an internal `smartpbx.playout_drained` metric when the paced local queue reaches the `tts.end` tail; SmartPBX smokes wait for that local drain metric before graceful teardown.
- Websocket, emulated Twilio, emulated Telnyx, and emulated SmartPBX smoke scripts now write a shared `manifest.json` run artifact with transport, sample-rate, byte-count, duration, turn, latency, and quality-gate fields. Manifest schema v2 separates websocket wire bytes from decoded/normalized PCM bytes, so compressed telephony evidence no longer mixes Opus/PCMU payload size with PCM duration math. `writeSmokeArtifactManifest()` validates schema, byte totals, duration math, and required compressed-audio provenance before writing artifacts.
- The websocket smokes now assert no negative timing, all VAD boundaries are observed, multi-burst VAD timing keeps the first speech start and latest speech end for the logical turn, and longform replies are not visibly truncated.
- The browser review console defaults to continuous listening after the user starts the microphone; it no longer promotes push-to-talk. Browser-side energy gating allocates a new context with 400 ms pre-speech audio, while VAD/Smart Turn and Deepgram finalize determine end-of-turn.
- See `VOICE-ENGINE-HARDENING.md` for the current research synthesis from ElevenLabs, AssemblyAI, Telnyx, Modal, Rapida, Pipecat, and LiveKit.

## Live Baselines

### Interactive Review

Command:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-interactive
```

Latest successful baseline:

| Item | Value |
|---|---:|
| Scenario | `websocket_university_student_relations_interactive` |
| Turns | 3 |
| Input/output PCM | 16 kHz mono s16le |
| TTS provider | Cartesia streaming websocket |
| Trailing silence | 1,400 ms |
| Post-TTS drain | 500 ms |
| Avg STT final after speech end | 1,363 ms |
| Avg VAD speech end after audio end | 665 ms |
| Avg LLM first text after STT final | 3,123 ms |
| Avg Cartesia first audio after first agent text | 373 ms |
| Avg speech end to first assistant audio | 4,859 ms |
| Quality gate | Passed |

Artifacts:

- `examples/02-hello-voice-headless/test/performance/websocket-university-interactive-baseline.json`
- `examples/02-hello-voice-headless/test/performance/runs/websocket-university-interactive-2026-05-27T15-51-07-393Z/manifest.json`

### Longform Websocket

Command:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-university
```

Latest successful completed run:

| Item | Value |
|---|---:|
| Scenario | `websocket_university_student_relations_multiturn` |
| Turns | 24 |
| Modeled conversation | 730,728 ms (~12.2 min) |
| User fixture audio | 333,024 ms |
| Assistant TTS audio | 397,704 ms |
| Avg STT final after speech end | 2,180 ms |
| Avg VAD speech end after audio end | 1,747 ms |
| Avg LLM first text after STT final | 3,629 ms |
| Avg Gemini TTS first audio after agent end | 10,450 ms |
| Avg speech end to first assistant audio | 16,258 ms |
| Quality gate | Passed after re-evaluation with critical-turn tool gate |

Artifacts:

- `examples/02-hello-voice-headless/test/performance/websocket-university-multiturn-baseline.json`
- `examples/02-hello-voice-headless/test/performance/runs/websocket-university-2026-05-27T10-03-12-076Z/`

Interpretation: endpointing is now bounded by Smart Turn + Deepgram provider finalize instead of the old 15-20 s generic guard. The remaining longform bottleneck is Gemini LLM/free-tier latency and Gemini's non-streaming TTS generation.

### Live Recorder Coherence

Command:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:live-recorder-coherence
```

Latest successful completed run:

| Item | Value |
|---|---:|
| Scenario | `live_university_recorder_three_turn_coherence` |
| Turns | 3 |
| STT / LLM / TTS | Deepgram / Gemini / Cartesia |
| Local audit STT | Whisper `tiny.en` |
| Avg STT final after audio end | 907 ms |
| Avg VAD speech end after audio end | 585 ms |
| Avg LLM first text after STT final | 3,699 ms |
| Avg first audio after agent text | 423 ms |
| Avg speech end to first assistant audio | 5,029 ms |
| Recorder user audio | 67,900 ms / 2,172,800 bytes |
| Recorder assistant audio | 88,001 ms / 2,816,026 bytes |
| Quality gate | Passed |

Artifacts:

- `examples/02-hello-voice-headless/test/performance/runs/live-university-recorder-2026-05-28T18-12-45-039Z/baseline.json`
- `examples/02-hello-voice-headless/test/performance/runs/live-university-recorder-2026-05-28T18-12-45-039Z/recorder/three-turn-live/manifest.json`
- `examples/02-hello-voice-headless/test/performance/runs/live-university-recorder-2026-05-28T18-12-45-039Z/turn-recordings/`

## Commands

Generate the user-side Gemini TTS WAV fixtures:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless fixtures:gemini-university
```

Run the full websocket multi-turn smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-university
```

Run the interactive websocket latency smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-interactive
```

Run the browser runtime capture smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:browser-runtime
```

Latest browser runtime result: local Chrome drove the actual browser review console, captured fake microphone input through `getUserMedia` and `AudioContext` at 48 kHz, encoded 89 frames / 56,664 decoded PCM bytes as 16 kHz `syrinx.audio.v1` binary envelopes (`sentEnvelopeFrames: 89`), and the server received the same 89 frames. The smoke server emitted one enveloped assistant-audio frame back to the page; the browser decoded 16,000 assistant PCM bytes at 16 kHz, scheduled playback without errors, observed one `audio_clear`, and continuous listening opened the next capture context after clear (`startedTurns: 2`). Artifact: `examples/02-hello-voice-headless/test/performance/runs/browser-runtime-2026-05-28T19-41-05-074Z/baseline.json`.

Run the live three-turn recorder coherence smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:live-recorder-coherence
```

Latest live recorder result: `live-university-recorder-2026-05-28T18-12-45-039Z` passed all three university turns with Deepgram `nova-3` STT, Gemini agent, Cartesia TTS, recorder WAV export, per-turn WAV export, and local Whisper coherence. The run preserved provider STT text, recorded raw agent replies separately from spoken TTS text, captured non-empty user/assistant audio with zero truncations, and produced average latencies: STT final after audio end 907 ms, VAD speech end after audio end 585 ms, first agent text after STT 3,699 ms, first audio after agent text 423 ms, speech-end to first assistant audio 5,029 ms. Deepgram metrics show `stt_provider_finalize_requested` after Smart Turn and `stt_provider_final_buffer_released` only after provider `speechFinal:true` or `fromFinalize:true`.

The live recorder smoke exports both continuous and per-turn listenable WAVs. `recorder-user.wav` and `recorder-assistant.wav` are stacked session tracks. New runs also write `turn-recordings/<turn-id>-<fixture-id>-user.wav` and `turn-recordings/<turn-id>-<fixture-id>-assistant.wav`, and list those paths under `recorder.turnRecordings` in `baseline.json`. The user-side per-turn WAVs are sliced from the recorder PCM by actual recorder offsets, including the post-user silence sent for endpointing; assistant per-turn WAVs are built from turn-scoped `tts.audio` chunks and are checked against recorder byte counts when no truncation occurs.

Run the emulated Twilio phone-to-agent websocket smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:twilio-emulator
```

Latest clean Twilio emulator result: 7 inbound phone frames, 1,120 inbound PCMU wire bytes, 4,480 normalized engine PCM bytes, max inbound media gap 22 ms, 12 paced outbound PCMU frames / 1,920 wire bytes, 2 outbound marks including 1 terminal end mark after playback mark acknowledgement, first outbound media 26 ms after the last inbound media frame reached the server, quality gate passed. The run wrote schema-v2 artifact `examples/02-hello-voice-headless/test/performance/runs/twilio-emulator-2026-05-29T03-32-55-228Z/manifest.json`. Package tests also cover delayed-session startup buffering, top-level `sequenceNumber` gap metrics, inbound `media.chunk` gap metrics, duplicate/regressing sequence/chunk rejection before STT/VAD, provider `stop`, abrupt socket disconnect, queued-output overflow, and outbound send-buffer refusal during pending playout: unsent media is cancelled, recorder output is truncated, discard metrics are delivered under blocked main dispatch, and no end mark leaks after teardown.

Run the emulated Telnyx phone-to-agent websocket smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telnyx-emulator
```

Latest clean Telnyx emulator result: 7 inbound phone frames, 1,120 inbound PCMU wire bytes, 4,480 normalized engine PCM bytes, max inbound media gap 22 ms, 12 paced outbound PCMU frames / 1,920 wire bytes, 2 outbound marks including 1 terminal end mark after playback mark acknowledgement, first outbound media 27 ms after the last inbound media frame reached the server, quality gate passed. The run wrote schema-v2 artifact `examples/02-hello-voice-headless/test/performance/runs/telnyx-emulator-2026-05-29T03-32-55-227Z/manifest.json`. Package tests also cover delayed-session startup buffering, top-level `sequence_number` gap metrics, inbound `media.chunk` gap metrics, duplicate/regressing sequence/chunk rejection before STT/VAD, provider `stop`, abrupt socket disconnect, queued-output overflow, and outbound send-buffer refusal during pending playout: unsent media is cancelled, recorder output is truncated, discard metrics are delivered under blocked main dispatch, and no end mark leaks after teardown.

Run the emulated SmartPBX phone-to-agent websocket smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:smartpbx-emulator
```

Latest deterministic SmartPBX emulator results, all with bursty carrier timing and one internal `smartpbx.playout_drained` signal before hangup: `g711_ulaw`/8 kHz passed with 7 inbound phone frames, 1,120 inbound PCMU wire bytes, 4,480 normalized engine PCM bytes, max inbound media gap 62 ms, 12 paced outbound PCMU frames / 1,920 wire bytes decoding to 3,840 PCM bytes, first outbound media 28 ms after the last inbound media frame reached the server, and schema-v2 artifact `examples/02-hello-voice-headless/test/performance/runs/smartpbx-emulator-g711_ulaw-2026-05-28T14-02-49-405Z/manifest.json`. `pcm16`/24 kHz passed with 6,720 inbound wire bytes, 11,520 outbound wire/decoded PCM bytes, max inbound media gap 62 ms, and artifact `examples/02-hello-voice-headless/test/performance/runs/smartpbx-emulator-pcm16-2026-05-28T14-03-02-633Z/manifest.json`. Opus/48 kHz passed with 1,016 inbound Opus wire bytes, 4,480 normalized engine PCM bytes, max inbound media gap 61 ms, 12 paced outbound Opus frames / 1,669 wire bytes decoding to 23,040 PCM bytes, first outbound media 29 ms after the last inbound media frame reached the server, and artifact `examples/02-hello-voice-headless/test/performance/runs/smartpbx-emulator-opus-2026-05-28T14-03-02-633Z/manifest.json`. Package tests also cover delayed-session startup buffering, `g711_ulaw`, `pcm16`, Opus decode/encode, partial Opus flush on `tts.end`, terminal `hangup`, abrupt socket disconnect, queued-output overflow, and outbound send-buffer refusal during pending playout: unsent media is cancelled locally, recorder output is truncated, discard metrics are delivered under blocked main dispatch, and no undocumented provider clear event is invented.

Run the live-provider telephony adapter smoke with the university fixture:

```bash
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=twilio pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=telnyx pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=smartpbx pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
```

Latest live-provider adapter results, all using Deepgram `nova-3`, Gemini `gemini-2.5-flash`, Cartesia, the `01-late-add` university fixture, `SYRINX_TELEPHONY_NETWORK_PROFILE=jittery`, decoded carrier WAV + local Whisper checks, and recorder manifests with zero assistant truncations:

| Provider | Artifact | Max inbound media gap | STT final after audio end | LLM first text after STT | First TTS audio after agent text | First carrier outbound after last inbound | Outbound wire bytes | Quality gate |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Twilio | `test/performance/runs/telephony-university-live-twilio-2026-05-28T12-41-24-007Z/baseline.json` | 202 ms | 862 ms | 4,224 ms | 464 ms | 202 ms | 84,739 | Passed |
| Telnyx | `test/performance/runs/telephony-university-live-telnyx-2026-05-28T12-42-20-134Z/baseline.json` | 85 ms | 886 ms | 4,595 ms | 459 ms | 624 ms | 77,678 | Passed |
| SmartPBX | `test/performance/runs/telephony-university-live-smartpbx-2026-05-28T12-43-17-181Z/baseline.json` | 100 ms | 959 ms | 5,320 ms | 492 ms | 1,381 ms | 82,881 | Passed |

Latest bursty live-provider adapter results, using the same live providers and fixture but `SYRINX_TELEPHONY_NETWORK_PROFILE=bursty`:

| Provider | Artifact | Max inbound media gap | STT final after audio end | LLM first text after STT | First TTS audio after agent text | First carrier outbound after last inbound | Outbound wire bytes | Terminal end marks | Recorder truncations | Quality gate |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Twilio | `test/performance/runs/telephony-university-live-twilio-2026-05-28T13-06-09-819Z/baseline.json` | 190 ms | 981 ms | 5,087 ms | 426 ms | 1,098 ms | 77,676 | 1 | 0 | Passed |
| Telnyx | `test/performance/runs/telephony-university-live-telnyx-2026-05-28T13-07-03-890Z/baseline.json` | 86 ms | 931 ms | 5,426 ms | 487 ms | 1,469 ms | 78,421 | 1 | 0 | Passed |
| SmartPBX | `test/performance/runs/telephony-university-live-smartpbx-2026-05-28T13-14-12-207Z/baseline.json` | 193 ms | 892 ms | 6,007 ms | 464 ms | 2,047 ms | 88,826 | 0 (`localPlayoutDrains: 1`) | 0 | Passed |

This smoke is local/emulated at the carrier websocket boundary but uses live STT/LLM/TTS providers. It proves provider audio, transcript, agent, TTS, carrier playout, marks where applicable, recorder flush, decoded carrier inbound/outbound WAV export, and non-empty local Whisper transcripts for both voice-in and voice-out across each adapter. It does not replace a real carrier/sandbox call.

### Synthetic Carrier-To-Bot Fly Spike

Because no live Twilio/Telnyx/SmartPBX carrier accounts were available, the current production-replication path uses two public hosts:

- `review:telephony` as the bot server.
- `review:synthetic-carrier` as the carrier host that calls the bot over provider-shaped websockets.

Latest Fly spike, `2026-05-29`, ran two disposable one-machine apps in `sin`, both `shared-cpu-1x:1024MB`, both auto-stopping and destroyed after artifact download:

| Provider | Network | Inbound frames | Outbound frames | Completion evidence | Quality gate |
|---|---|---:|---:|---|---|
| Twilio | jittery | 1,263 | 537 | `outboundEndMarks: 1` | Passed |
| Telnyx | jittery | 1,263 | 575 | `outboundEndMarks: 1` | Passed |
| SmartPBX | jittery | 1,263 | 485 | `outboundQuietDrains: 1` | Passed |

Bot recorder artifacts were downloaded before teardown to `examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-2026-05-29T03-42-37-213Z/`. Each provider session has `events.jsonl`, `manifest.json`, `user_audio.pcm`, `assistant_audio.pcm`, and listenable `user_audio.wav` / `assistant_audio.wav`. Carrier-boundary `carrier-inbound.wav` and `carrier-outbound.wav` are also saved per provider. The bot WAVs validated as RIFF PCM, 16-bit, mono, 16 kHz; the carrier-boundary WAVs validated as RIFF PCM, 16-bit, mono, 8 kHz. `fly apps list` showed no remaining `syrinx-bot-spike-260529034237` or `syrinx-carrier-spike-260529034237` apps after teardown.

Use `TELEPHONY-VOICE-HANDOFF.md` for the exact local and Fly commands. The new `smoke:fly-synthetic-carrier` command automates app creation, `--ha=false` deploy, artifact download, and app destruction. The synthetic carrier path does not prove carrier account signaling, but it does prove public TLS websocket routing, carrier-shaped audio packet delivery, live Deepgram/Gemini/Cartesia processing, bot recorder output, and provider-shaped assistant audio return across the network.

Start the human review studio:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless review:studio
# open http://127.0.0.1:4173
```

Human browser test details are documented separately in `BROWSER-VOICE-HANDOFF.md`. Important: do not open `packages/voice-client-browser/index.html` via `file://`; run `review:studio` so localhost serves the HTML and hosts `ws://127.0.0.1:4173/ws` in the same process. The manual flow is `Connect` -> `Start Listening` -> speak naturally -> wait for VAD/Smart Turn/Deepgram finalization -> verify agent text and assistant audio -> speak during assistant playback to verify interruption clear.

Start the live/sandbox carrier review server:

```bash
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @asyncdot-example/02-hello-voice-headless review:telephony
```

The server exposes one live university-support engine behind `WS /twilio`, `WS /telnyx`, and `WS /media-stream`, plus `GET /twilio/twiml`, `POST /twilio/status`, `POST /telnyx/webhook`, and `GET /telephony/config.json` for carrier setup. Local preflight on `127.0.0.1:4181` passed for `/healthz`, `/telephony/config.json`, and `/twilio/twiml`. Live-provider telephony adapter smokes now pass for Twilio, Telnyx, and SmartPBX websocket shapes, but real carrier execution still requires a public TLS endpoint and a carrier/sandbox call. Human carrier test details are documented separately in `TELEPHONY-VOICE-HANDOFF.md`.

Run the public TLS websocket probe before wiring a carrier dashboard:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless probe:telephony-public https://your-public-tls-host.example
```

The same probe can target local review servers for command verification. Latest local verification against `http://127.0.0.1:4184` passed `/healthz`, `/telephony/config.json`, `/twilio/twiml`, `POST /twilio/status`, `POST /telnyx/webhook`, Twilio/Telnyx/SmartPBX provider-shaped websocket sessions, and asserted no websocket compression was negotiated. This is still a routing/upgrade preflight, not a substitute for real carrier/sandbox media timing.

Run a real outbound Twilio carrier call once Twilio credentials and phone numbers are available:

```bash
TWILIO_ACCOUNT_SID=AC... \
TWILIO_AUTH_TOKEN=... \
TWILIO_FROM_NUMBER=+15551234567 \
TWILIO_TO_NUMBER=+15557654321 \
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:twilio-carrier-call
```

This harness uses Twilio's REST API to create an outbound call to `/twilio/twiml`, polls until terminal call status, writes `test/performance/runs/twilio-carrier-call-*/baseline.json`, and fails unless Twilio returns final status `completed` with non-zero duration. It does not replace recorder/server inspection for websocket media timing; use it with the review server logs and recorder artifacts.

Run a real outbound Telnyx carrier call once Telnyx credentials and phone numbers are available:

```bash
TELNYX_API_KEY=... \
TELNYX_CONNECTION_ID=... \
TELNYX_FROM_NUMBER=+15551234567 \
TELNYX_TO_NUMBER=+15557654321 \
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telnyx-carrier-call
```

This harness uses Telnyx `POST /v2/calls` with provider-native bidirectional RTP streaming fields pointed at `/telnyx`, waits for the configured dwell window, sends the Telnyx hangup command by default, and writes `test/performance/runs/telnyx-carrier-call-*/baseline.json`. It proves Telnyx accepted the real call-control command and streaming contract; use it with review-server logs and recorder artifacts for media timing proof.

Run local verification:

```bash
pnpm -r typecheck
pnpm -r test
git diff --check
```

Latest websocket package verification includes 72 tests, including early pre-ready browser audio buffering, malformed pre-ready audio preserving transport error semantics, delayed-session telephony `start`/`media` buffering, provider-stop and abrupt-disconnect teardown during queued telephony playout, recorder truncation and critical discard metrics under blocked main dispatch, queued-output overflow closure, resume-window lifecycle, sample-rate normalization, strict `syrinx.audio.v1` sample-rate metadata validation, default outbound binary envelopes with raw-output opt-out, single-frame outbound send-buffer overflow closure, SmartPBX Opus/48 kHz encode/decode and final-frame flush, malformed PCM/base64 rejection, heartbeat probing, slow-consumer closure, Twilio/Telnyx slow-consumer regressions proving unsent playback marks are not reported as sent, Twilio/Telnyx/SmartPBX late interrupted-context audio suppression, and Twilio/Telnyx/SmartPBX send-buffer regressions proving failed media-frame sends immediately clear queued playout and record truncation metrics. Core voice package verification now covers interrupted-generation suppression: late LLM deltas, late LLM done, and late TTS audio for an interrupted context do not reopen TTS or recorder output. Deepgram package verification now covers provider finalize buffering plus malformed provider JSON, provider error frames, unexpected close frames, and failed audio sends not being counted as sent audio. Cartesia package verification now covers header auth, context finalization, interruption cancellation, cancelled-context late frame suppression, provider error frames, malformed provider messages, provider close while a context is active, and failed initial/terminal text sends not being retained as active provider contexts. Example verification also covers smoke artifact manifest schema v2 invariants, including rejection of compressed telephony artifacts that omit decoded PCM provenance, derive duration from Opus wire bytes, or omit telephony carrier-relative latency fields.

## Known Gaps

Critical next hardening:

- Twilio, Telnyx, and SmartPBX endpoints are deterministic-emulator tested and live-provider adapter-smoke tested, including real Deepgram/Gemini/Cartesia and recorder output. A live/sandbox carrier review server exists and local HTTP preflight passed, but no real carrier call has been completed yet. The next telephony step is running live/sandbox calls against that server to validate provider-specific start/media/termination timing and, only for Twilio/Telnyx where documented, playback `mark`/`clear` behavior.
- SmartPBX documentation does not define a playback-buffer clearing command. Barge-in remains visible in engine/recorder metrics, but carrier-side queued assistant audio cannot be cleared until SmartPBX confirms a supported control event.
- Recorder manifests are package-level covered and live-smoke covered with local Whisper coherence checks. Smoke artifacts are now schema v2 with explicit wire and decoded PCM byte fields; keep recorder and smoke manifest fields aligned as the artifact schema evolves.
- Cartesia is the preferred interactive review TTS path when `CARTESIA_API_KEY` is present. The production plugin has a live header-auth smoke result on 2026-05-28 (`13` chunks / `50,526` PCM bytes for a short utterance). Gemini TTS is still chunked and creates 7-20 s longform TTS outliers.
- Gemini LLM TTFT is still multi-second on the current key. A paid/low-latency Gemini setup is still needed to approach the sub-second target.
- Do not promote fixture-specific semantic term lists to production gates. Use them, if needed, as smoke diagnostics beside provider transcripts, recorder audio, and local Whisper output; production pass/fail should be based on transport/provider invariants and explicit provider finalization behavior.

## Notes For Next Session

- Do not delete `test-cartesia-output.pcm` unless explicitly asked; it is an unrelated untracked local artifact.
- The new `stt.finalize` packet is a command from turn detection to STT; Deepgram responds by sending its provider `Finalize` message. The Deepgram plugin now requires both Pipecat approval and provider closure (`speech_final` or `from_finalize`) before releasing buffered provider-final text, with a metric-marked cached fallback only if the provider does not answer.
- Smart Turn should not be replaced with raw VAD silence finalization. A short VAD-ended timer caused premature transcript cuts on realistic utterances.
- Keep separate profiles:
  - `interactive-review`: 16 kHz websocket PCM, Smart Turn, Deepgram provider finalize, Cartesia TTS.
  - `longform`: Gemini-generated user fixtures, 16 kHz websocket ingress, Smart Turn, Deepgram provider finalize, Gemini TTS artifacts.
