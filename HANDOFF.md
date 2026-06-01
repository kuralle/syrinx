# Syrinx Voice Engine - Session Handoff

> **Operating directive for anyone (human or agent) continuing this work — embody it:**
> Take an autonomous stand, and deliver the work. Do not ask for permissions, do not ask questions (take all the
> well-researched recommendations into account). You have the right tools to find your answers. Fend for yourself
> and deliver results. Do the whole thing. Do it right. Do it with tests. Do it with documentation. Do it so well
> that the reviewer is genuinely impressed — not politely satisfied, actually impressed. No shortcuts, no deferring,
> no "table this for later", no workarounds when the real fix exists. Root out the cause. Embrace breaking changes
> over back-compat for the best outcome. Search before building, test before shipping, ship the complete thing.
> When asked for something, the answer is the finished product, not a plan to build it. Time is not an excuse.
> Fatigue is not an excuse. Complexity is not an excuse. Boil the ocean. Don't fight errors — research 3–5 fixes,
> pick the most efficient, implement it. Keep a running notes file of decisions/tradeoffs not in the spec.
>
> Active reliability work: see `VOICE-ENGINE-FAILURE-MODES.md` (grounded gap catalog) and
> `RELIABILITY-HARDENING-NOTES.md` (research trail).

> **Sprint 01 — WebSocket transport hardening + scale (2026-05-31) — operating directive:**
> Take an autonomous stand, and deliver the work. Do not ask for permissions, do not ask
> questions (take all the well-researched recommendations into account). You have the right
> tools to find your answers. Fend for yourself and deliver results. Let's begin. Do the whole
> thing. Do it right. Time is not an excuse. Fatigue is not an excuse. Complexity is not an
> excuse. Boil the ocean.
>
> **NO shortcuts, NO DEFERRING, NO "I'll do this for later"** — all of these are excuses. If
> something needs time, take your time. Never stop tasks early due to token-budget concerns;
> always complete tasks fully even as the budget runs low. Even if a task seems to need genuine
> follow-up scope, DON'T DEFER.
>
> Don't fight errors: when you hit one, research the web and/or use your tools to find 3–5
> possible fixes, choose the most efficient, and implement it. While you do, keep a running
> `implementation-notes.md` with decisions not in the spec, things you had to change, tradeoffs,
> and anything the reviewer should know.
>
> Do it with tests. Do it with documentation. Do it so well the reviewer is genuinely impressed —
> not politely satisfied, actually impressed. Never "table this for later" when the permanent
> solve is in reach. Never leave a dangling thread when tying it off takes five more minutes.
> Never present a workaround when the real fix exists. The standard isn't "good enough" — it's
> "holy shit, that's done." Root out the cause. Embrace breaking changes over back-compat for the
> best outcome. Search before building. Test before shipping. Ship the complete thing. When asked
> for something, the answer is the finished product, not a plan to build it.
>
> Sprint board + issues: `issues/sprint-01-websocket-transport/` (README + KANBAN + WT-01..09 +
> VE-01..05). Catalog: `VOICE-ENGINE-FAILURE-MODES.md` §7 (G13–G26). This is a long sprint that
> needs proper TDD and smoke testing with live API keys. Every issue: failing test → fix → green,
> a live-API/transport smoke where a boundary is touched, docs, and a regression assertion.

**Date:** 2026-06-01 (latest pass: Browser Studio Live-Conversation)
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
- The websocket transport now advertises its PCM contract on `ready`, validates browser JSON message shape at runtime before forwarding to the engine bus, requires `sampleRateHz` on JSON and enveloped binary audio frames, normalizes PCM16 input to the engine sample rate, rejects malformed odd-byte PCM, and emits `tts_chunk` metadata before each binary assistant-audio frame. Assistant TTS packets now also carry source `sampleRateHz`, so Cartesia's 16 kHz PCM and Gemini's 24 kHz PCM are timed and resampled from provider truth instead of a transport-side assumption.
- Browser websocket input now enforces a turn-scoped audio-rate invariant: every audio frame for one `contextId` on a websocket connection must use the same source sample rate. A new context may declare a different rate, but a mid-context `sampleRateHz` change is rejected as invalid transport input instead of being silently resampled into the same STT stream.
- Browser websocket input now treats optional JSON/enveloped `sequence` values as transport evidence. Duplicate or regressing input sequence values are rejected before the frame reaches VAD/STT, while forward gaps are accepted but recorded as `websocket.audio_sequence_gap` metrics with expected, actual, and missed frame counts.
- The websocket server now attaches its input path immediately on socket connection and buffers bounded early client frames until `ready`. This protects against browser/client SDKs that send audio right after WebSocket `open` while the `VoiceAgentSession` is still starting.
- Non-telephony websocket assistant audio now uses the `syrinx.audio.v1` binary envelope by default, carrying turn id, sample rate, sequence, encoding, channel count, duration, and byte length in-frame. Inbound binary clients may use the same envelope; enveloped audio requires a valid positive-integer `sampleRateHz`, even-byte PCM16 payloads, matching `byteLength`, and matching duration metadata when supplied, so malformed timing/format metadata is rejected instead of silently defaulting or creating misleading transport evidence. The shared envelope encoder enforces the same invariants before writing bytes, so production senders cannot use the official helper to emit frames that the receiver would later reject. Raw inbound PCM16 is disabled by default and available only by explicitly setting `rawBinaryInput: true` for managed clients that already guarantee the advertised input sample rate. Raw outbound PCM is available only by explicitly setting `binaryAudioEnvelope: false`. Outbound assistant audio is normalized from the TTS packet source rate to the websocket's advertised output rate before the envelope is written.
- Browser and telephony websocket endpoints now attach their input handlers immediately on socket connection and buffer bounded early frames until the session is ready, so browser audio and carrier `start`/first `media` frames are not lost during session startup. They also fail closed if session startup does not reach `ready`, run heartbeat pings, close sessions that exceed a bounded max transport duration, close slow consumers with code `1013` before the outbound assistant-audio buffer grows unbounded, count the next outbound frame against the send-buffer ceiling before sending so one oversized frame cannot bypass backpressure, close oversized inbound messages with code `1009`, validate JSON envelope shape before reading nested provider/client fields, and reject malformed base64 media before it reaches the engine. Defaults: 15 s startup timeout, 30 s heartbeat, 30 min max session duration, 8 MiB buffered-send ceiling, 2 MiB browser inbound ceiling, 256 KiB telephony inbound ceiling.
- Websocket servers now use explicit `noServer` upgrade routing and disable websocket compression. This prevents shared HTTP servers with `/twilio`, `/telnyx`, and `/media-stream` adapters from racing independent `server + path` upgrade listeners and corrupting public websocket handshakes. Package coverage includes all three carrier adapters mounted on the same HTTP server, plus compression-negotiation assertions.
- Browser websocket sessions now expose a stable `sessionId` in `ready` and can resume the same in-memory `VoiceAgentSession` with `?sessionId=...` during a 15 s default retention window. Stale socket listeners are disposed on disconnect so resumed sessions do not double-send events. The retained session also preserves the current turn id, per-context source sample-rate locks, and input sequence state, so reconnect/resume cannot bypass the same-stream audio invariants.
- Websocket clients receive VAD `speech_started` / `speech_ended`, `audio_clear`, and `agent_interrupted`; the browser review console flushes queued output audio on interruption.
- The browser review console sends microphone frames as `syrinx.audio.v1` binary envelopes, decodes default enveloped assistant audio before playback/artifact accounting, and still uses `tts_chunk` as lifecycle sideband for UI timing. Fixture websocket smoke harnesses continue to use JSON audio frames with explicit `sampleRateHz` for deterministic scripted input.
- `@asyncdot/voice-client-browser` now has tested browser audio utilities for 48 kHz and 44.1 kHz capture down to 16 kHz PCM16, including Float32 clamping, turn-scoped JSON frame encoding for compatibility, and default binary envelope transport. `sendAudioBase64()`, `sendAudioPcm()`, and `sendFloat32Audio()` all attach monotonic sequence metadata by default, and reject duplicate/regressing explicit sequence overrides before send, so browser-client audio evidence matches the server's sequence guard. Inbound server JSON is runtime-validated before it is emitted to UI handlers; malformed server messages surface as client errors instead of silently becoming typed timeline events.
- The headless example now includes a Chrome runtime capture smoke against the real browser review console. It uses `getUserMedia`, `AudioContext`, fake microphone input, 48 kHz -> 16 kHz browser-side encoding, and a real websocket server to verify every microphone frame is sent as an envelope, received as decoded PCM, and kept to one gated capture context.
- `@asyncdot/voice-recorder` now waits for pending file writes on close, consumes recording packets from the bus audit stream so critical truncation survives blocked main dispatch during shutdown, supports assistant-audio truncation on barge-in and terminal transport playout discard, rejects odd-byte PCM16 recording packets before they can create misleading audio artifacts, requires `record.assistant_audio.sampleRateHz` on every non-truncation assistant audio packet, locks assistant recording sample rate from that metadata, rejects mixed-rate assistant PCM inside one recorder session, closes owned streams even when a recorder validation/write error is reported, lifts listener caps on owned write streams during high-volume recording, and writes `manifest.json` with sample rates, byte counts, chunk counts, truncation count, and artifact paths. The recorder manifest is validated before write for schema version, sample rates, PCM16 byte alignment, duration math, and path consistency so recorder evidence cannot drift silently from the smoke artifact contract. Telephony review generated WAV endpoints now use the recorder manifest's assistant sample rate instead of assuming 16 kHz, so Gemini 24 kHz recorder artifacts are listenable/transcribable at the correct rate. The session emits `record.assistant_audio` with `truncate: true` before TTS/LLM interruption, and telephony adapters emit the same correction when queued assistant audio is discarded, mirroring Rapida/LiveKit-style recorder behavior so queued but unheard assistant audio is not preserved as if it played.
- `@asyncdot/voice-stt-deepgram` follows provider semantics: session-long websocket, provider `Finalize`, `is_final` transcript buffering, text-frame `KeepAlive` during idle/post-turn playout, and `CloseStream` only during session shutdown. It releases only after Pipecat-approved finalization plus provider `speech_final`/`from_finalize`, does not promote cached/interim text to final on finalize timeout or close, does not reconstruct provider finals with English token heuristics, and converts malformed provider JSON, Deepgram `type:"Error"`/`err_*` frames, unconfirmed `Finalize` timeouts, failed audio sends, and unexpected websocket close frames into structured `stt.error` packets. Any recoverable Deepgram reconnect now discards unconfirmed provider transcript/finalize/audio-delivery state before opening the replacement websocket, so stale provider state cannot leak into a later turn; `stt_provider_reconnect_discarded_state` records that discard. Deepgram `NET-*` close reasons map to recoverable connection failures; `DATA-*` close reasons map to fatal input failures. Provider-boundary audio byte metrics now advance only after the Deepgram websocket accepts the frame for send.
- `@asyncdot/voice` sentence-buffers streamed LLM deltas before speech. Completed sentences are sent to TTS as soon as they arrive; any remaining provider-completed tail is flushed at `llm.done` and recorded as `tts.final_tail_flushed`. This follows the production pattern in LiveKit/Pipecat where LLM text remains streamable but TTS consumers coalesce text before synthesis and flush remaining text at response end.
- `@asyncdot/voice` requires TTS packet sample-rate metadata when estimating assistant playback duration and when routing assistant audio to the recorder. Missing `tts.audio.sampleRateHz` is surfaced as a pipeline error instead of falling back to an assumed provider rate; maintained Cartesia and Gemini plugins emit their actual provider PCM rates.
- `@asyncdot/voice` now treats interruption as a terminal generation boundary for that context. Late LLM deltas, late LLM done events, and late TTS audio for an interrupted context are ignored and recorded as metrics instead of reopening speech after barge-in. Browser, Twilio, Telnyx, and SmartPBX websocket transports also suppress late `tts.audio`/`tts.end` for interrupted contexts so stale provider/plugin output cannot restart playout or emit terminal marks after a clear. This closes the race where provider cancellation is asynchronous and stale generation can arrive after the engine has already yielded to the caller.
- `@asyncdot/voice-tts-cartesia` now follows Cartesia's current websocket context contract: the API key is sent in the `X-API-Key` header instead of the URL, each utterance keeps one `context_id`, `tts.done` finishes the context with an empty terminal continuation, and `interrupt.tts` sends documented `{ context_id, cancel: true }` requests for active contexts. Provider `type:"error"` frames, malformed provider JSON, malformed provider audio payloads, websocket errors, provider closes while contexts are active, and failed initial or terminal text sends are converted into context-scoped `tts.error` packets instead of throwing out of the websocket listener or leaving a hung TTS context. Contexts are tracked as active only while there is evidence that provider sends succeeded, so `tts.done` does not flush text that never reached Cartesia and later interruptions do not cancel contexts whose terminal flush failed. Cartesia also suppresses late `data`/`done` frames for cancelled contexts so stale provider audio cannot leak back onto the bus after barge-in. Audio is decoded only from non-empty `data`: the `flush_done` acknowledgement that Cartesia returns for the `flush: true` terminal continuation carries an empty `data` string, which is a control frame and is no longer mis-decoded as malformed audio (this was caught by the live recorder smoke and previously failed every turn with `tts.error` "audio data must be valid base64"). Legacy helper scripts that call Cartesia directly now use header auth as well.
- `@asyncdot/voice-bridge-aisdk` records AI SDK provider finish reasons and fails the turn instead of emitting `llm.done` when Gemini ends with `length`, `content-filter`, `error`, `tool-calls`, `other`, or no finish metadata. The university profile uses a larger voice token budget (`1024` interactive, `1400` longform) and defaults Deepgram to `nova-3`, with `SYRINX_DEEPGRAM_MODEL` and `SYRINX_DEEPGRAM_LANGUAGE` still configurable.
- `VoiceAgentSession.close()` now shares one in-flight finalization promise across concurrent close callers. This prevents telephony `stop`/disconnect, harness cleanup, and server shutdown from finalizing plugins concurrently; recorder manifests are no longer vulnerable to partial writes or duplicate truncation during racing closes.
- `@asyncdot/voice-server-websocket` now exposes a Twilio Media Streams websocket endpoint. It validates Twilio `start.mediaFormat`, validates top-level `sequenceNumber` continuity when present, decodes inbound PCMU/8 kHz media to engine PCM16/16 kHz, validates inbound `media.chunk` continuity when present, emits `twilio.sequence_gap` and `twilio.media_chunk_gap` metrics for forward gaps, records provider presentation-time anomalies as `twilio.media_timestamp_gap` and `twilio.media_timestamp_regression` without using timestamp drift as a transcript gate, rejects duplicate/regressing sequence/chunk values before they reach VAD/STT, emits assistant PCM back as paced 20 ms Twilio PCMU `media` frames, sends Twilio `mark` only after the paced audio batch drains, records inbound carrier `mark` acknowledgements as metrics, maps engine TTS interruptions to local queue clear plus Twilio `clear`, and treats provider `stop`, abrupt websocket disconnect, outbound playout overflow, and outbound send-buffer refusal as terminal discard boundaries by cancelling already queued playout, truncating recorder output, and recording `twilio.stop_playout_cleared_ms`, `twilio.disconnect_playout_cleared_ms`, `twilio.overflow_playout_cleared_ms`, or `twilio.send_buffer_playout_cleared_ms`. Outbound Twilio `mark_sent` and `clear_sent` metrics are emitted only when the corresponding JSON control frame actually enters the websocket send path. Terminal Twilio end marks are kept pending until all prior playback marks are acknowledged, so graceful teardown can wait for provider-confirmed playout completion instead of byte counts alone.
- `@asyncdot/voice-server-websocket` now also exposes a Telnyx-style Media Streaming websocket endpoint. It validates Telnyx `start.media_format`, treats top-level `sequence_number` as observability because Telnyx does not guarantee websocket event order, supports inbound PCMU/8 kHz and L16/16 kHz mono payloads, reorders inbound `media.chunk` frames inside a bounded four-frame default window before STT, force-drains buffered inbound media on `stop` or abrupt websocket disconnect, emits `telnyx.sequence_gap`, `telnyx.sequence_regression`, and `telnyx.media_chunk_gap` metrics for transport evidence, rejects duplicate/stale chunks before they reach VAD/STT, records provider presentation-time anomalies as `telnyx.media_timestamp_gap` and `telnyx.media_timestamp_regression` without using timestamp drift as a transcript gate, normalizes inbound media to engine PCM16, emits outbound paced `media` frames using the configured `stream_bidirectional_codec` mirror (`bidirectionalCodec`), sends `mark` after paced drain, records mark acknowledgements, maps interruption to local queue clear plus Telnyx `clear`, and treats provider `stop`, abrupt websocket disconnect, outbound playout overflow, and outbound send-buffer refusal as terminal discard boundaries by cancelling queued playout, truncating recorder output, and recording the matching `telnyx.*_playout_cleared_ms` metric. Outbound Telnyx `mark_sent` and `clear_sent` metrics are emitted only when the corresponding JSON control frame actually enters the websocket send path. Terminal Telnyx end marks are kept pending until all prior playback marks are acknowledged, matching the Twilio graceful-drain behavior.
- `@asyncdot/voice-server-websocket` now exposes a SmartPBX AI Provider endpoint at `/media-stream`. It validates SmartPBX `start.mediaFormat`, supports `g711_ulaw`/8 kHz, little-endian `pcm16`/24 kHz, and Opus/48 kHz payloads, normalizes inbound audio to engine PCM16, sends paced outbound `media` with the required `callId` and `accountId`, clears unsent local playout on interruption, and treats `hangup`/`stop`, abrupt websocket disconnect, outbound playout overflow, and outbound send-buffer refusal as terminal discard boundaries by cancelling queued local playout, truncating recorder output, and recording the matching `smartpbx.*_playout_cleared_ms` metric. Opus output is encoded as valid 20 ms frames and partial final PCM is flushed on `tts.end`. The documented SmartPBX contract does not define playback `mark` or `clear`, so no undocumented provider command is emitted. Instead, the adapter emits an internal `smartpbx.playout_drained` metric when the paced local queue reaches the `tts.end` tail; SmartPBX smokes wait for that local drain metric before graceful teardown.
- Websocket, emulated Twilio, emulated Telnyx, and emulated SmartPBX smoke scripts now write a shared `manifest.json` run artifact with transport, sample-rate, byte-count, duration, turn, latency, and quality-gate fields. Manifest schema v2 separates websocket wire bytes from decoded/normalized PCM bytes, so compressed telephony evidence no longer mixes Opus/PCMU payload size with PCM duration math. `writeSmokeArtifactManifest()` validates unknown parsed data without throwing, including schema, supported encodings, byte totals, duration math, required compressed-audio wire and decoded-PCM provenance, quality-gate consistency, and non-empty decoded voice-in/voice-out evidence before a manifest can claim `qualityGate.passed: true`.
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
| Avg STT final after speech end | 914 ms |
| Avg VAD speech end after audio end | 642 ms |
| Avg LLM first text after STT final | 3,604 ms |
| Avg Cartesia first audio after first agent text | 408 ms |
| Avg speech end to first assistant audio | 4,926 ms |
| Quality gate | Passed |

Artifacts:

- `examples/02-hello-voice-headless/test/performance/websocket-university-interactive-baseline.json`
- `examples/02-hello-voice-headless/test/performance/runs/websocket-university-interactive-2026-05-29T08-46-48-968Z/manifest.json`

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
| Avg STT final after audio end | 921 ms |
| Avg VAD speech end after audio end | 589 ms |
| Avg LLM first text after STT final | 4,233 ms |
| Avg first audio after agent text | 428 ms |
| Avg speech end to first assistant audio | 5,582 ms |
| Recorder user audio | 67,900 ms / 2,172,800 bytes |
| Recorder assistant audio | 93,851 ms / 3,003,232 bytes |
| Quality gate | Passed |

Artifacts:

- `examples/02-hello-voice-headless/test/performance/runs/live-university-recorder-2026-05-30T12-28-13-902Z/baseline.json`
- `examples/02-hello-voice-headless/test/performance/runs/live-university-recorder-2026-05-30T12-28-13-902Z/recorder/three-turn-live/manifest.json`
- `examples/02-hello-voice-headless/test/performance/runs/live-university-recorder-2026-05-30T12-28-13-902Z/turn-recordings/`

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

Latest browser runtime result: local Chrome drove the actual browser review console, captured fake microphone input through `getUserMedia` and `AudioContext` at 48 kHz, encoded 87 frames / 55,298 decoded PCM bytes as 16 kHz `syrinx.audio.v1` binary envelopes (`sentEnvelopeFrames: 87`), and the server received the same 87 frames. The smoke server emitted one enveloped assistant-audio frame back to the page; the browser decoded 16,000 assistant PCM bytes at 16 kHz, scheduled playback without errors, observed one `audio_clear`, and continuous listening opened the next capture context after clear (`startedTurns: 2`). Artifact: `examples/02-hello-voice-headless/test/performance/runs/browser-runtime-2026-05-29T13-04-06-779Z/baseline.json`.

Run the live three-turn recorder coherence smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:live-recorder-coherence
```

Latest live recorder result: `live-university-recorder-2026-05-29T08-42-51-566Z` passed all three university turns with Deepgram `nova-3` STT, Gemini agent, Cartesia TTS, recorder WAV export, per-turn WAV export, and local Whisper coherence. The recorder coherence smoke reads the recorder manifest before writing stacked and per-turn assistant WAVs, so those review artifacts use the actual recorded assistant sample rate instead of a provider guess. The run preserved provider STT text, recorded raw agent replies separately from spoken TTS text, captured non-empty user/assistant audio with zero truncations, and produced average latencies: STT final after audio end 866 ms, VAD speech end after audio end 587 ms, first agent text after STT 3,791 ms, first audio after agent text 470 ms, speech-end to first assistant audio 5,127 ms. Deepgram metrics show `stt_provider_finalize_requested` after Smart Turn and `stt_provider_final_buffer_released` only after provider `speechFinal:true` or `fromFinalize:true`; unconfirmed provider finalization now emits `stt_provider_finalize_timeout`/`stt.error` instead of a cached final transcript.

The live recorder smoke exports both continuous and per-turn listenable WAVs. `recorder-user.wav` and `recorder-assistant.wav` are stacked session tracks. New runs also write `turn-recordings/<turn-id>-<fixture-id>-user.wav` and `turn-recordings/<turn-id>-<fixture-id>-assistant.wav`, and list those paths under `recorder.turnRecordings` in `baseline.json`. The user-side per-turn WAVs are sliced from the recorder PCM by actual recorder offsets, including the post-user silence sent for endpointing; assistant per-turn WAVs are built from turn-scoped `tts.audio` chunks and are checked against recorder byte counts when no truncation occurs.

Run the emulated Twilio phone-to-agent websocket smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:twilio-emulator
```

Latest clean Twilio emulator result: 7 inbound phone frames, 1,120 inbound PCMU wire bytes, 4,480 normalized engine PCM bytes, max inbound media gap 22 ms, 12 paced outbound PCMU frames / 1,920 wire bytes, 2 outbound marks including 1 terminal end mark after playback mark acknowledgement, first outbound media 28 ms after the last inbound media frame reached the server, quality gate passed. The run wrote schema-v2 artifact `examples/02-hello-voice-headless/test/performance/runs/twilio-emulator-2026-05-29T08-32-37-768Z/manifest.json`. Package tests also cover delayed-session startup buffering, top-level `sequenceNumber` gap metrics, inbound `media.chunk` gap metrics, duplicate/regressing sequence/chunk rejection before STT/VAD, provider `stop`, abrupt socket disconnect, queued-output overflow, and outbound send-buffer refusal during pending playout: unsent media is cancelled, recorder output is truncated, discard metrics are delivered under blocked main dispatch, and no end mark leaks after teardown.

Run the emulated Telnyx phone-to-agent websocket smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telnyx-emulator
```

Latest clean Telnyx emulator result: 7 inbound phone frames, 1,120 inbound PCMU wire bytes, 4,480 normalized engine PCM bytes, max inbound media gap 22 ms, 12 paced outbound PCMU frames / 1,920 wire bytes, 2 outbound marks including 1 terminal end mark after playback mark acknowledgement, first outbound media 27 ms after the last inbound media frame reached the server, quality gate passed. The run wrote schema-v2 artifact `examples/02-hello-voice-headless/test/performance/runs/telnyx-emulator-2026-05-29T08-32-47-536Z/manifest.json`. Package tests also cover delayed-session startup buffering, top-level `sequence_number` gap/regression metrics, bounded inbound `media.chunk` reordering before STT/VAD, inbound media chunk gap metrics when the reorder window is exceeded or the stream stops/disconnects, duplicate/stale chunk rejection before STT/VAD, provider `stop`, abrupt socket disconnect, queued-output overflow, and outbound send-buffer refusal during pending playout: unsent media is cancelled, buffered inbound media is force-drained, recorder output is truncated, discard metrics are delivered under blocked main dispatch, and no end mark leaks after teardown.

Run the emulated SmartPBX phone-to-agent websocket smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:smartpbx-emulator
```

Latest deterministic SmartPBX emulator result: `g711_ulaw`/8 kHz passed with 7 inbound phone frames, 1,120 inbound PCMU wire bytes, 4,480 normalized engine PCM bytes, max inbound media gap 22 ms, 12 paced outbound PCMU frames / 1,920 wire bytes decoding to 3,840 PCM bytes, one internal `smartpbx.playout_drained` signal before hangup, first outbound media 27 ms after the last inbound media frame reached the server, and schema-v2 artifact `examples/02-hello-voice-headless/test/performance/runs/smartpbx-emulator-g711_ulaw-2026-05-29T08-32-54-135Z/manifest.json`. Broader codec coverage remains in package tests for `g711_ulaw`, `pcm16`/24 kHz, and Opus/48 kHz, including Opus decode/encode and partial Opus flush on `tts.end`. Package tests also cover delayed-session startup buffering, terminal `hangup`, abrupt socket disconnect, queued-output overflow, and outbound send-buffer refusal during pending playout: unsent media is cancelled locally, recorder output is truncated, discard metrics are delivered under blocked main dispatch, and no undocumented provider clear event is invented.

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

This smoke is local/emulated at the carrier websocket boundary but uses live STT/LLM/TTS providers. It proves provider audio, transcript, agent, TTS, carrier playout, marks where applicable, recorder flush, decoded carrier inbound/outbound WAV export, and non-empty local Whisper transcripts for both voice-in and voice-out across each adapter. It is the local floor before the public Fly synthetic carrier run.

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

Bot recorder artifacts were downloaded before teardown to `examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-2026-05-29T03-42-37-213Z/`. Each provider session has `events.jsonl`, `manifest.json`, `user_audio.pcm`, `assistant_audio.pcm`, and listenable `user_audio.wav` / `assistant_audio.wav`. Carrier-boundary `carrier-inbound.wav` and `carrier-outbound.wav` are also saved per provider. The bot recorder manifests are validated with the same `@asyncdot/voice-recorder` manifest contract used at write time, so the Fly artifact validator rejects duration/path/schema drift before accepting downloaded evidence. Downloaded `events.jsonl` is also validated for route/context/timestamp envelope shape, event-to-packet `kind`/`contextId`/`timestampMs` consistency, required speech pipeline event kinds, sanitized audio byte metadata, and assistant/TTS sample-rate metadata before the run is accepted. The bot WAVs validated as RIFF PCM, 16-bit, mono, 16 kHz; the carrier-boundary WAVs validated as RIFF PCM, 16-bit, mono, 8 kHz. `fly apps list` showed no remaining `syrinx-bot-spike-260529034237` or `syrinx-carrier-spike-260529034237` apps after teardown.

Use `TELEPHONY-VOICE-HANDOFF.md` for the exact local and Fly commands. The new `smoke:fly-synthetic-carrier` command automates app creation, `--ha=false` deploy, artifact download, local evidence validation, and app destruction. For this hardening goal, the synthetic carrier path is the accepted production-replication run: Mac/local command -> Fly carrier sandbox -> Fly agent bot -> downloaded recorder/event evidence -> destroyed Fly apps. It does not prove account-provider dashboard signaling, but it proves public TLS websocket routing, carrier-shaped audio packet delivery, live Deepgram/Gemini/Cartesia processing, bot recorder output, provider-shaped assistant audio return, and teardown across the network. The carrier runtime gate now compares decoded PCM counters against the exact captured PCM chunks before accepting a run. The local validator now fails the smoke if the downloaded bundle is missing provider completion evidence, bot recorder manifest/events, user/assistant PCM/WAV evidence, a downloaded carrier call result that matches the summary `callResult`, or 8 kHz carrier-boundary WAV evidence with decoded PCM byte counts matching the carrier metrics.

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

The server exposes one live university-support engine behind `WS /twilio`, `WS /telnyx`, and `WS /media-stream`, plus `GET /twilio/twiml`, `POST /twilio/status`, `POST /telnyx/webhook`, and `GET /telephony/config.json` for carrier setup. Local preflight on `127.0.0.1:4181` passed for `/healthz`, `/telephony/config.json`, and `/twilio/twiml`. Live-provider telephony adapter smokes now pass for Twilio, Telnyx, and SmartPBX websocket shapes, and the Fly synthetic carrier run covers the accepted public-TLS carrier-sandbox path. Real Twilio/Telnyx/SmartPBX accounts are still documented as provider-account validation. Human carrier test details are documented separately in `TELEPHONY-VOICE-HANDOFF.md`.

Run the public TLS websocket probe before wiring a carrier dashboard:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless probe:telephony-public https://your-public-tls-host.example
```

The same probe can target local review servers for command verification. Latest local verification against `http://127.0.0.1:4184` passed `/healthz`, `/telephony/config.json`, `/twilio/twiml`, `POST /twilio/status`, `POST /telnyx/webhook`, Twilio/Telnyx/SmartPBX provider-shaped websocket sessions, and asserted no websocket compression was negotiated. This is a routing/upgrade preflight; use the Fly synthetic carrier run for public-host media timing evidence.

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

Latest local verification on 2026-05-30: `pnpm -r typecheck`, `pnpm -r test`, deterministic Twilio/Telnyx/SmartPBX emulator smokes, browser runtime smoke, the live three-turn recorder coherence smoke (`live-university-recorder-2026-05-30T12-28-13-902Z`, quality gate passed with coherent Whisper transcripts of recorded user and assistant audio), and `git diff --check` all passed. The websocket package verification includes 109 tests, including early pre-ready browser audio buffering, explicit browser and provider-shaped JSON message validation before bus forwarding, explicit JSON audio sample-rate metadata enforcement, explicit raw websocket input opt-in, malformed pre-ready audio preserving transport error semantics, startup-timeout closure before `ready` across browser/Twilio/Telnyx/SmartPBX websockets, delayed-session telephony `start`/`media` buffering, provider-stop and abrupt-disconnect teardown during queued telephony playout, recorder truncation and critical discard metrics under blocked main dispatch, queued-output overflow closure, resume-window lifecycle with retained turn/sample-rate/sequence invariants, max session duration closure across browser/Twilio/Telnyx/SmartPBX websockets, sample-rate normalization, strict `syrinx.audio.v1` sample-rate/duration/byte-length metadata validation, default outbound binary envelopes with raw-output opt-out, single-frame outbound send-buffer overflow closure, SmartPBX Opus/48 kHz encode/decode and final-frame flush, malformed PCM/base64 rejection, heartbeat probing, slow-consumer closure, Twilio/Telnyx sequence/chunk/timestamp metrics, Telnyx out-of-order media chunk reordering and terminal reorder drain, Twilio/Telnyx slow-consumer regressions proving unsent playback marks are not reported as sent, Twilio/Telnyx/SmartPBX late interrupted-context audio suppression, and Twilio/Telnyx/SmartPBX send-buffer regressions proving failed media-frame sends immediately clear queued playout and record truncation metrics. Recorder verification covers odd-byte PCM16 rejection, mandatory assistant sample-rate evidence, and stream cleanup on validation failure. Core voice package verification covers strict `syrinx.audio.v1` envelope validation, mandatory TTS audio sample-rate metadata before playback/recording, and interrupted-generation suppression: late LLM deltas, late LLM done, and late TTS audio for an interrupted context do not reopen TTS or recorder output. Deepgram package verification covers provider finalize buffering plus malformed provider JSON, provider error frames, unexpected close frames, and failed audio sends not being counted as sent audio. Cartesia package verification covers header auth, context finalization, interruption cancellation, cancelled-context late frame suppression, empty-`data` `flush_done` acknowledgement handling (not mis-decoded as malformed audio), provider error frames, malformed provider messages, provider close while contexts are active, and failed initial/terminal text sends not being retained as active provider contexts. Example verification covers smoke artifact manifest schema v2 invariants, including malformed parsed JSON returning explicit failures, rejection of compressed telephony artifacts that omit wire or decoded PCM provenance, use unsupported encodings, carry odd decoded PCM byte counts, derive duration from Opus wire bytes, or omit telephony carrier-relative latency fields.

## Reliability Hardening Pass (2026-05-30)

A grounded reliability investigation (Deepgram "Definitive Guide to Voice AI Agents" PDF + LiveKit JS/Python, Rapida, and Pipecat source + web research, all fact-checked) produced `VOICE-ENGINE-FAILURE-MODES.md` (the gap catalog) and `RELIABILITY-HARDENING-NOTES.md` (the research trail). Shipped from it:

- **G1 — false-barge-in gate (core engine).** `VoiceAgentSession` no longer cuts the agent off on the first VAD speech frame. New `minInterruptionMs` config (default 280 ms) defers `interrupt.detected` until `vad.speech_activity` shows the user's speech sustained past the threshold; a `vad.speech_ended` before then suppresses it (`interrupt.suppressed_short_speech`), and the assistant finishing during the window resolves the gate without a stale cut (`interrupt.gate_resolved_after_tts_end`). Committed cuts emit `interrupt.committed_after_ms`. `minInterruptionMs: 0` restores the legacy immediate cut. This kills transient noise / clicks / very short blips (the most common false interruptions); deliberate ≥280 ms spoken backchannels still commit. `@asyncdot/voice` now has 49 tests.
- **Cartesia `flush_done` fix** (earlier this session): the adapter decodes audio only from non-empty `data`, so Cartesia's empty-`data` `flush_done` acknowledgement of a `flush:true` terminal continuation is no longer mis-decoded as malformed audio (it previously failed every live turn). `@asyncdot/voice-tts-cartesia` now has 10 tests.
- **Fly synthetic-carrier entry-point fix.** `start-telephony-spike.ts` did a bare side-effect `import()` of the serve modules, but they only auto-run `main()` behind a direct-entry guard, so the Fly bot exited 0 without binding `0.0.0.0:4180` and `/healthz` timed out. `main` is now exported from `serve-telephony-review.ts` / `serve-synthetic-carrier.ts` and the wrapper awaits it. **The two-host Fly run now passes end-to-end** for Twilio/Telnyx/SmartPBX with live Deepgram/Gemini/Cartesia, downloads bot + carrier artifacts, and destroys both apps (verified: `qualityGate.passed:true`, no apps leaked).

Documented-but-not-yet-shipped (precisely specified in `VOICE-ENGINE-FAILURE-MODES.md`): G2 (interrupted-turn history divergence — needs cross-component spoken-prefix truncation; a partial fix was investigated and reverted after a deadlocking test exposed the real mechanism), G3 (mid-turn STT/TTS stall watchdog), G4 (graceful degradation / provider fallback), G5 (telephony comfort-frame pacer + deadline metric), G6 (function-call interruption contract), G7 (live VAQI/SLO telemetry), G8 (provider concurrency/rate-limit backoff), G9 (long-call WS write-after-close soak), G10 (bus head-of-line blocking on long sync handlers — found during the G2 investigation).

Latest reliability-pass verification on 2026-05-30: `pnpm -r typecheck` (exit 0, all 13 projects), `pnpm -r test` (exit 0, 253 passed / 1 skipped), `git diff --check` clean, and the live Fly synthetic-carrier run passed for all three carriers with both apps destroyed.

## Connection-Portability Pass (2026-05-31)

All three provider websocket plugins (Deepgram STT, Cartesia TTS, Deepgram Aura TTS) now share one connection manager instead of three bespoke connect/reconnect/keepalive implementations. The manager is grounded in Pipecat's `WebsocketService` pattern and is runtime-portable across Node, the browser, and Cloudflare Workers.

- **New package `@asyncdot/voice-ws`.** `WebSocketConnection` is the shared base: `connect()`/`ensureReady()`/`send()`/`close()`/`reset()` plus private `openSocket()`, `tryReconnect()` (quick-failure guard via `_MIN_STABLE_CONNECTION_DURATION`/`_MAX_CONSECUTIVE_QUICK_FAILURES` + exponential backoff), `giveUp()`, and `startKeepAlive()`. Provider plugins supply only a `socketFactory`, a `keepAliveMessage`, and message/connection-lost handlers; the backoff/verify/quick-failure/keepalive machinery lives once in the base. 6 package tests (messages+keepalive, verified reconnect, give-up, quick-failure, plus the `/web` and `/workers` full-manager adapters) all green.
- **Runtime portability via a `ManagedSocket` adapter.** `SocketFactory = (url, headers) => ManagedSocket | Promise<ManagedSocket>` decouples the manager from the socket implementation. Three adapters ship behind subpath exports: `./node` (`createNodeWsSocket`, the `ws` EventEmitter with real ping/pong verify+keepalive and constructor headers), `./web` (`wrapWebSocket`/`createWebSocketAdapter` over the standard built-in `WebSocket` — no ping frame, so `verify()` falls back to `readyState` and keepalive uses `keepAliveMessage`), and `./workers` (`createWorkersSocket`, the Cloudflare fetch-upgrade route: `fetch(url,{headers:{...,Upgrade:"websocket"}})` -> `resp.webSocket` -> `accept()`, because the Workers/browser `WebSocket` constructor cannot set auth headers). An already-open Workers socket connects without an `open` event because `onOpen` fires immediately when `readyState === OPEN`.
- **Plugins refactored onto the base.** `@asyncdot/voice-stt-deepgram`, `@asyncdot/voice-tts-cartesia`, and `@asyncdot/voice-tts-deepgram` each dropped their private connection fields/methods and now hold one `WebSocketConnection`, injecting `createNodeWsSocket` by default but accepting any `socketFactory` for non-Node runtimes. `ws` moved to devDependencies in all three. The STT finalize-timeout recovery uses the base's `reset()` (dispose + reconnect) so unconfirmed provider state is discarded before the replacement socket opens.
- **`@asyncdot/voice-tts-deepgram`** is the streaming Deepgram Aura plugin added this pass (commit `98fca36`): `wss://api.deepgram.com/v1/speak?...&encoding=linear16&container=none`, `Authorization: Token`, send `{type:"Speak"|"Flush"|"Clear"|"Close"}`, receive raw linear16 PCM + JSON control. ~329 ms TTFB vs Gemini chunked ~7.6 s, so it is the preferred Fly/longform TTS when its key has credits.
- **Stale-socket guard** (`1c613e6`, found by `/thermo-nuclear-code-quality-review`): a replaced socket's late `close` could clobber a healthy reconnection. `openSocket()` handlers now check `socket === this.socket` (`isActive()`) before mutating shared state, while `settle()` stays unguarded so a close mid-reconnect can't hang.
- **Naming** (`d694c11`): the non-standard `Whatwg*` socket types were renamed to the stdlib-mirroring `WebSocketLike`/`WebSocketEventLike` (confirmed Cloudflare's own package and PartySocket use the standard `WebSocket`/`MessageEvent`, not "WHATWG").

Session commits: `98fca36` (Aura TTS), `e68df5e` (shared base + both TTS), `1c613e6` (stale-socket guard), `b67276a` (runtime-portable adapter), `d694c11` (rename), `5b2aaf6` (STT onto base + Workers socket), `d86f926` (Fly bot `SYRINX_REVIEW_TTS` secret).

### Regression verification (`/diagnose`)

The refactor touches the provider hot path, so it was verified end-to-end on Fly, not just on the headless smoke. The full two-host synthetic-carrier deployment (`SYRINX_REVIEW_TTS=deepgram`, run dir `fly-synthetic-carrier-2026-05-31T08-57-54-100Z`, `sin`, `shared-cpu-1x:1024MB`, jittery) passed for all three carriers — **no regression**:

| Provider | Inbound frames | Outbound frames | Completion evidence | Quality gate |
|---|---:|---:|---|---|
| Twilio | 1,263 | 780 | `outboundEndMarks: 1` | Passed |
| Telnyx | 1,263 | 806 | `outboundEndMarks: 1` | Passed |
| SmartPBX | 1,263 | 937 | `outboundQuietDrains: 1` | Passed |

`cleanup` confirmed `botDestroyed: true` / `carrierDestroyed: true`. Each downloaded telephony `conversation.wav` measured **0.0 s overlap** via `scripts/analyze-overlap.mjs`, STT transcribed, and `qualityGate.failures` was empty for every provider. Lesson recorded: changes to the provider-connection layer need the Fly telephony E2E as the definitive check — the headless smoke does not exercise the carrier transports.

## Browser Studio Live-Conversation Pass (2026-06-01)

A persistent browser studio is deployed to Fly for live human conversation with the
university-support agent: **`https://syrinx-studio-mcj.fly.dev`** (app `syrinx-studio-mcj`,
`sin`, `shared-cpu-1x:1024MB`, auto-stop, `Dockerfile.studio-spike` + `fly.studio-spike.toml`,
serving the raw `packages/voice-client-browser/index.html` over `/ws`). Driving it with a real
microphone surfaced two production bugs the headless/carrier smokes never hit, plus a third
(turn-finalization) whose root is still under investigation.

**Lesson — Fly deploys for these spike apps MUST use `--no-cache`.** The Depot build cache reused
a pre-fix `COPY packages` layer and shipped stale source while reporting success, producing two
false "it's fixed" cycles. Every `fly deploy` for `Dockerfile.*-spike` now gets `--no-cache --ha=false`.

**Lesson — verify the real dirty-input path, not a clean shortcut.** A JSON-audio e2e and a
frame-*counting* harness both gave false green: the inbound bug needs an odd-byteOffset envelope
subarray, and the downlink bug needs the browser to actually *decode* the envelope (counting frames
hides it). Probes now replicate the exact browser decode (`.handoff/downlink-decode-repro.mjs`).

Shipped (branch `v2`):

- **Inbound odd-offset VAD crash (`3535ca0`, prior session-adjacent + `ef59838` test).** The browser
  `syrinx.audio.v1` envelope decodes `.audio` as a subarray at offset `7+4+headerLen` — frequently
  **odd** — and Silero VAD did `new Int16Array(buf.buffer, buf.byteOffset, …)`, which throws
  `RangeError: start offset of Int16Array should be a multiple of 2`. Carrier paths realign on µ-law/Opus
  decode so only the browser envelope path hit it. Fixed with the offset-safe `pcm16BytesToSamples`
  (DataView-based) from `@asyncdot/voice/audio`; codex regression sweep audited the whole bug class
  (`REGRESSION-ALIGNMENT.md`).
- **Downlink codec mismatch (`d351737`, hardened `2ce94cf`).** The studio `index.html`
  assistant-audio decoder is **PCM16-only — it ignores `metadata.encoding`** — but the server defaults
  to **Opus** downlink (`browserOpusDownlink ?? true`). So the server streamed Opus envelopes the page
  rejected with "PCM16 payload must contain an even number of bytes" / "durationMs mismatch" — text
  replies worked, no voice played. Fix: the page sends `codec_capability: {downlinkEncoding:"pcm_s16le"}`
  on socket open so the server streams PCM. Live red→green: 236/236 frames failed without the handshake,
  0/234 with it. Hardening (`2ce94cf`, R-02): the decoder now branches on `metadata.encoding` and rejects
  non-PCM loudly instead of failing as cryptic PCM. Guards: `studio-page.test.ts` + a strengthened
  server PCM-downlink test (even bytes + matching durationMs).
- **STT finalize-timeout reset cascade (`af69623`, hardened `2ce94cf`).** Under rapid restart/barge-in
  speech, Deepgram's `from_finalize` echo didn't arrive within the timeout → `handleProviderFinalizeTimeout`
  discarded the turn AND called `conn.reset()`, which reopens a fresh Deepgram stream (losing context);
  the next turn's audio awaits the reconnect and hits a context-less stream → another timeout → another
  reset → a cascade (observed: 3 errors in 23 s, STT-final 4498 ms). Fix: count **consecutive** finalize
  timeouts, only `reset()` at `finalize_reset_threshold` (default 2); a single timeout keeps the healthy
  socket. After this: 1 isolated error, STT-final 776 ms. Hardening (`2ce94cf`, R-01): the counter is also
  cleared on a socket-close reconnect (`discardProviderStateForReconnect`) so a stale count can't force an
  avoidable reset post-reconnect. Both behaviors have red→green regression tests using a fake Deepgram
  `ws` server. Studio interactive `provider_finalize_timeout_ms` raised 1500→3000 for headroom.
- **Dropped-turn symptom mitigation (`cee6698`) — band-aid, now superseded by the root fix below.** A
  *single* finalize timeout discarded its turn, emitting no `stt.result`, so `voice-turn-pipecat` never
  emitted `eos.turn_complete` → the turn hung on "Waiting for assistant…". Added opt-in
  `finalize_timeout_fallback` (complete the turn from buffered text on timeout). It did NOT fully fix the
  hang — instrumentation later showed the hung turns never even reach the timeout (see root cause) — so
  the fallback is now demoted to a rare provider-anomaly safety net, not the completion path.

**Root cause — CONFIRMED (live instrumentation) and FIXED (`7598c42`).** Temporary `[FZDRIFT]` logging on
the deployed studio proved the exact mechanism, which is sharper than "the provider is slow": when the user
starts a new utterance **before** the previous turn's Deepgram finalize confirms, the browser mints a new
`contextId`, the server fires `turn.change`, and the Deepgram plugin's `turn.change` handler **deleted the
outgoing context's pending finalize** (cleared its timer + `finalizeRequested`). The orphaned turn then
**never completed, timed out, or hit the fallback** — it hung on "finalizing" forever. Every stuck turn in
the trace showed `turn.change … pendingFinalize=TRUE`; the sole determinant of success was whether the user
paused long enough for the provider to confirm before speaking again. (Analysis:
`issues/sprint-01-websocket-transport/codex-review/TURN-FINALIZE-ROOTCAUSE.md`.)

The root fix (`7598c42`, codex impl, manager-reviewed against the diff, WBS R-01..R-05):
- **R-01 single turn authority.** The browser keeps **one** capture context across a VAD `speech_ended`
  pause and only opens a new context after the server commits the turn. Server relays `eos.turn_complete`
  → browser `turn_complete`; the browser nulls `activeTurn` on that signal, not on `speech_ended`. Stops
  the context churn that raced ahead of Smart-Turn.
- **R-02 decouple text from finalize.** Every Deepgram `is_final` is emitted as `stt.result` regardless of
  `speech_final`/`from_finalize` (the pipecat/livekit pattern). Smart-Turn (`voice-turn-pipecat`) stays the
  semantic EOS authority and gates premature cuts via `smartTurnComplete && semanticComplete`, so earlier
  text does NOT cut users off — this respects the prior "naive VAD timer cut people off" finding rather than
  repeating it.
- **R-03 fix the orphaning + correlate Finalize.** `turn.change` no longer clears the outgoing context's
  finalize state; transcript state is now **per-`contextId`** (was a shared-field bug); provider finals are
  FIFO-correlated to the requesting context, not the drifted current one.
- **R-04 integration replay** (`examples/02-hello-voice-headless/test/turn-finalize-rootfix.test.ts`): real
  STT + real EOS plugins; a restarted utterance under one context completes as **exactly one** turn with the
  combined text and **no** `stt_provider_finalize_timeout`/`_fallback` metric.
- **R-05** `finalize_timeout_fallback` retained as a rare provider-anomaly net.

Verification: `pnpm -r typecheck` + `pnpm -r test` green across all 13 packages
(`voice-stt-deepgram` 18, `voice-turn-pipecat` 21, `voice-client-browser` 55, `voice-server-websocket` 167
incl. telephony, example 58/1-skip); earlier cascade/counter/fallback regression tests intact; no
`.skip`/`@ts-ignore`/weakening. Deployed `--no-cache`. **Pending: human-mic live re-confirmation** of the
restart scenario on the studio (the clean-audio harness cannot reproduce the live context-churn path).
Recommended pre-merge for telephony: the Fly synthetic-carrier E2E, since this touches the shared Deepgram
plugin (per the connection-layer lesson below).

### Turn-taking quality: over-segmentation + audio overlap (2026-06-01, after the root fix)

Once turns completed (root fix above), the *next* layer surfaced: a mid-thought pause made Smart-Turn
commit a partial turn, the agent started replying, and the continuation produced a **second**
`eos.turn_complete` on the **same** contextId while turn-1 TTS was still playing → two replies **overlapped**.

- **Session-scoped observability (`3fcbff5`).** The studio writes one JSONL per WS session to
  `$SYRINX_OBS_DIR` (default `/tmp/syrinx-obs/<sessionId>.jsonl`) capturing the turn lifecycle
  (`vad.speech_started/ended`, `stt.result`, `eos.turn_complete`, `tts.first_audio/tts.end`,
  `interrupt.*`, `stt.error`, finalize/interrupt metrics). Read on Fly with
  `fly ssh console -C 'cat /tmp/syrinx-obs/<file>'`. It reproduced the overlap as a clean trace
  (one utterance → two `eos.turn_complete`, same context) — the evidence that grounded the fix.
- **Fix (`6fd79c7`, WBS R-01..R-05 + obs-sharpened R-03b), grounded in a Pipecat/LiveKit browser-client
  study (`BROWSER-TURNTAKING.md`):**
  - R-03: removed the bogus `words>=5 ⇒ complete` heuristic (`semantic-completeness.ts`) and gated the 50 ms
    semantic shortcut behind `confidence>=0.85 && semanticShortcutDelayMs>0` (disabled for interactive) —
    Smart-Turn (the model) is the endpoint authority, not a word count.
  - R-03b: per-context **lock** in `PipecatEOSPlugin` — on `finalize` the context is locked and turn handlers
    early-return, so **no second `eos.turn_complete` fires while the assistant is still speaking**; released on
    `tts.playout_progress {complete}` / `tts.end` (no audio) / `interrupt.detected`.
  - R-01/R-02: **client-side barge-in** — browser local-RMS speech-start → `flushOutputAudio()` +
    `client_interrupt` WS control → `requestClientInterrupt` → turn-arbiter `commitClientInterrupt` →
    `interrupt.detected(source:"client")` clears playout. Browser VAD is barge-in-only, never an EOS signal
    (honors the "naive VAD timer cut people off" finding).
  - R-04: rebalanced interactive endpoint config (`finalize_delay_ms` 250→450, `incomplete_fallback_ms`
    2200→3200, `semantic_shortcut_delay_ms` 0). No raw-VAD silence timer.
- **Verified:** `pnpm -r typecheck` + `pnpm -r test` green (all 13 packages; `voice-turn-pipecat` 25,
  `voice-server-websocket` 168 incl. telephony, `voice-client-browser` 57, example 60/1-skip); new tests prove
  no low-confidence shortcut and no same-context duplicate completion during playout. Deployed `--no-cache`;
  the obs trace on the live build shows the WAV now yields **one** `eos.turn_complete`, no stacked overlap.
- **Known tradeoff:** while a context is locked, a *short* trailing continuation is dropped (better than
  overlap); a *sustained* continuation barges in and becomes a new turn.

### ⚠️ Live testing still PENDING

All of the above (root fix + turn-taking + barge-in) is **unit/integration-verified and obs-confirmed on the
clean-audio harness, but NOT yet confirmed by a real human-mic session.** The clean harness cannot reproduce
the live context-churn / barge-in feel. Pending human-mic confirmation on `https://syrinx-studio-mcj.fly.dev`:
(1) pause mid-sentence → one reply, no overlap; (2) talk over the agent → its audio cuts (barge-in).
If natural speech still segments too eagerly, that's an R-04 endpoint-tuning dial, not an architecture gap.
Worker note: codex is rate-limited; future delegations use **pi-glm (GLM 5.1)** (see auto-memory).
Manager always reads the diff + runs the suite regardless of worker.

## Operational Follow-Up

- Twilio, Telnyx, and SmartPBX endpoints are deterministic-emulator tested, live-provider adapter-smoke tested, and public-TLS Fly synthetic-carrier tested with live Deepgram/Gemini/Cartesia plus recorder output. If real provider accounts become available, run the provider-account validation in `TELEPHONY-VOICE-HANDOFF.md` to validate dashboard/call-control setup and account-specific webhook timing.
- SmartPBX documentation does not define a playback-buffer clearing command. Barge-in remains visible in engine/recorder metrics, and local queued assistant audio is discarded; do not add a carrier-side SmartPBX clear command unless SmartPBX confirms a supported event.
- Recorder manifests are package-level covered and live-smoke covered with local Whisper coherence checks. Smoke artifacts are now schema v2 with explicit wire and decoded PCM byte fields; keep recorder and smoke manifest fields aligned as the artifact schema evolves.
- Cartesia is the preferred interactive review TTS path when `CARTESIA_API_KEY` is present. The production plugin has a live header-auth smoke result on 2026-05-28 (`13` chunks / `50,526` PCM bytes for a short utterance). Gemini TTS is still chunked and creates 7-20 s longform TTS outliers.
- Gemini LLM TTFT is still multi-second on the current key. A paid/low-latency Gemini setup is still needed to approach the sub-second target.
- Do not promote fixture-specific semantic term lists to production gates. Use them, if needed, as smoke diagnostics beside provider transcripts, recorder audio, and local Whisper output; production pass/fail should be based on transport/provider invariants and explicit provider finalization behavior.

## Notes For Next Session

- Do not delete `test-cartesia-output.pcm` unless explicitly asked; it is an unrelated untracked local artifact.
- The new `stt.finalize` packet is a command from turn detection to STT; Deepgram responds by sending its provider `Finalize` message. The Deepgram plugin now requires both Pipecat approval and provider closure (`speech_final` or `from_finalize`) before releasing buffered provider-final text, and treats an unconfirmed provider finalize timeout or recoverable provider reconnect as a state-discard boundary instead of carrying cached text forward.
- Smart Turn should not be replaced with raw VAD silence finalization. A short VAD-ended timer caused premature transcript cuts on realistic utterances.
- Keep separate profiles:
  - `interactive-review`: 16 kHz websocket PCM, Smart Turn, Deepgram provider finalize, Cartesia TTS.
  - `longform`: Gemini-generated user fixtures, 16 kHz websocket ingress, Smart Turn, Deepgram provider finalize, Gemini TTS artifacts.
