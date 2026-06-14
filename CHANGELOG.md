# Changelog

All `@kuralle-syrinx/*` packages are versioned and released in lockstep.

## 3.1.0 — 2026-06-14

### Added
- `cf-agents`: `withVoice` gains an `onToolCallStart?(ctx)` hook (`ctx = { toolName, args, sessionId,
  connection }`), fired the instant the front model invokes the delegate tool — **before** the
  reasoner runs. Lets a consumer emit a deterministic, in-language preamble or a "thinking" earcon
  that masks the 2–6 s reasoner wait (e.g. `connection.send(...)` to trigger a cached client-side
  earcon), instead of relying on the realtime front LLM to remember to speak one. A throwing app
  callback never affects the call. Exported `ToolCallStartContext`. (#21)

## 3.0.0 — 2026-06-14

Breaking, multi-package. Cloudflare is promoted from a spike to a **first-party, documented
runtime** — both Workers voice hosts are rebuilt onto the `agents` SDK via `withVoice(Agent)`,
with telephony, a deploy template, and a how-to (#10). New shared `tts-core`, `epsilon`, and
`cf-agents` packages. Realtime gains typed text input; edge barge-in truncates accurately.

### Breaking
- `server-workers`: both voice hosts are rebuilt onto `withVoice(Agent)` (the `cf-agents` mixin
  over the Cloudflare `agents` SDK). The Durable Objects are now `agents` Agents — `agents` is a
  new dependency. The session-assembly exports `createLiveVoiceAgentSession` /
  `createRealtimeVoiceAgentSession` are **removed**; the pipeline is now a `withVoice` descriptor
  (`liveCascadedPipeline` / `realtimeVoicePipeline` + reasoner factories). Deleted
  `alarm-scheduler.ts`, `durable-session-store.ts`, the manual `webSocketMessage/Close/Error`
  lifecycle, and the `1012` eviction-orphan path — the Agent's `keepAlive()` lease holds the
  isolate for the call, so mid-call eviction (and its workaround) cannot occur. The
  `/ws?sessionId=` URL scheme is unchanged.
- `server-workers-mastra`: the hand-rolled `alarm-scheduler` is removed (run pointers now expire
  lazily on read). The host stays a raw `DurableObject` — Mastra's own Cloudflare pattern.
- `kuralle`: the dead `streamFromKuralle` export is removed (`fromKuralleRuntime` wraps it).
- `gemini`: the TTS instruction lead-in defaults to **empty** (raw text). Deployments that want a
  persona must set `instruction` (previously every utterance was silently wrapped).

### Added
- `cf-agents`: new `@kuralle-syrinx/cf-agents` — `withVoice(Agent, options)`, a mixin over the
  Cloudflare `agents` SDK `Agent` that adds a Syrinx voice pipeline (realtime **or** cascaded),
  reusing the Agent's hibernation, `keepAlive()` lease, `Connection`, and SQL. `transport:
  "edge" | "twilio"` selects the Syrinx browser/edge protocol or the Twilio Media Streams (μ-law
  8 kHz) wire. The R2 `EdgeRecorder` ships at the `@kuralle-syrinx/cf-agents/r2-recorder`
  subexport. The reasoner defaults to `fromKuralleRuntime(this.runtime)` and can be overridden.
  `agents` is a `peerDependency`. See `examples/03-cf-agent-voice`.
- `tts-core`: new shared streaming-TTS deep module; `cartesia`, `grok`, and `epsilon` are built on
  it.
- `epsilon`: new multiplexed WebSocket TTS provider package.
- `realtime`: `RealtimeAdapter.sendText` — typed user turns on the realtime path, implemented for
  OpenAI Realtime and Gemini Live; `RealtimeBridge` forwards `user.text_received` to it. Also:
  front-level tool calls + full delegate-arg forwarding; `RealtimeBridgeOptions` is exported.
- `server-websocket` (edge): an inbound `{type:"playout_progress"}` client message maps onto a
  `tts.playout_progress` bus packet, so client-rendered-audio transports report true playout and
  realtime barge-in truncates the model's turn to the actually-heard offset.
- `server-workers`: a `TwilioVoiceConversation` telephony host (`/twilio`) and a `POST
  /incoming-call` Twilio Voice webhook that returns `<Connect><Stream>` TwiML bridging the PSTN
  leg to it.
- Docs: a **[Deploy Syrinx on Cloudflare](docs/guides/deploy-on-cloudflare.md)** how-to; Cloudflare
  is documented as a first-party runtime.

### Changed
- `realtime`: a shared `RealtimeEventStream` is extracted; the delegate query-arg name is
  configurable (`RealtimeBridgeOptions.delegateQueryArg`, default `"query"`); the assistant
  transcript now surfaces for delta-only providers (Gemini Live streams non-final fragments and
  never a final) without double-counting providers that send a final (OpenAI).
- `recorder`: runtime-agnostic WAV/stereo builders are extracted to the `/wav` subexport for
  Workers hosts.
- `browser-client`: codec negotiation no longer crashes when the socket drops mid-handshake — the
  advisory `codec_capability` is skipped on a closed socket and re-sent on the next `ready` after
  reconnect (the client already auto-reconnects with backoff + sessionId-resume).

### Fixed
- `realtime`: a delegate `tool_call` whose arguments lack a string query now emits a clear
  recoverable `llm.error` instead of silently reasoning over an empty string.
- `server-websocket` (edge): JSON `audio` frames are resampled from the client's `sampleRateHz` to
  the engine input rate and emit `turn.change` on contextId rotation — matching the binary and
  Node paths (previously a non-engine-rate JSON client got pitch/speed-corrupted audio).
- `server-websocket` (edge): the recording is finalized on an error-path disconnect, not only a
  clean close (a Workers `webSocketError` with no matching close no longer loses the recording or
  leaks the session lease).
- `server-websocket` (telnyx): the final paced outbound frame retains its `contextId`, so the
  playout clock counts it (was under-reporting played-out ms by one frame per burst).
- `tts-core`: a cancelled context no longer errors on connection loss.

## 2.1.1 — 2026-06-10

### Fixed
- `silero-vad`: the Workers variant (`/workers`, onnxruntime-web) had drifted from the Node
  variant — v2.1.0's telephony saturation hardening (stopping-state spike debounce, in-speech
  model-state reset) only landed in the Node copy. The VAD turn state machine and PCM windowing
  are now extracted into a single shared module (`vad-state-machine.ts`) used by both runtimes,
  with parity regression tests on the Workers entry, so the variants cannot drift again.

## 2.1.0 — 2026-06-10

First published release (npm, `@kuralle-syrinx` scope).

### Barge-in, provider-agnostic (all tiers)
- Provider-STT barge-in for VAD-less deployments: STT interim/final transcripts during active
  TTS playout are interruption evidence, with the same debounce, backchannel, and low-confidence
  suppression as the VAD path (`core`).
- `vad.speech_started` is now a documented provider-agnostic contract: any STT plugin with a
  native speech-start signal emits the same packet a local VAD does. `deepgram` opts in via
  `vad_events` (off by default — duplicate speech-start corrupts VAD-owned turn-taking on
  sessions with a local VAD).
- Browser client local barge-in (`browser-client`): playout-gated energy VAD on the uplink sends
  `client_interrupt` at local-VAD speed (default on when an `audioContext` is provided;
  `bargeIn: false` to disable). Jitter buffer exposes the playout clock
  (`isPlayingOut`/`activeContextId`).
- Edge WS path now sends `audio_clear`/`agent_interrupted` downlink on interruption
  (`server-websocket/edge`).

### Telephony
- Twilio Media Streams ingress on Cloudflare Workers (`server-websocket/edge-twilio`): μ-law
  8 kHz both ways, barge-in mapped to Twilio `clear`, pre-lease message buffering, per-turn
  contextId rotation.
- Mid-call drop/resume proven live: reconnect with the same sessionId re-attaches the live
  session inside the resume window (`ready.resumed: true`) with conversation memory intact.

### Production hardening (telephony root causes)
- `silero-vad`: flap-tolerant speech-end (single-frame confidence spikes no longer reset the
  silence countdown) plus periodic model-state reset during prolonged continuous speech —
  fixes Silero LSTM saturation on long telephony segments.
- `pipecat-smart-turn`: STT-quiet fallback — when finals exist and the transcript goes quiet
  while VAD still claims speech, boundary analysis runs anyway. A wedged VAD can no longer
  block turn completion.
- `core`: a throwing bus handler no longer kills the call — the error packet's `isRecoverable`
  verdict is authoritative.
- `server-websocket`: outbound playout overflow now tail-drops only what does not fit (was:
  clear everything and permanently silence the stream); default queue bound raised from 200 ms
  to 60 s across twilio/telnyx/smartpbx and the browser `/ws` pacing path. Burst-streaming TTS
  providers (e.g. Deepgram) no longer silence long replies.

### Realtime
- Gemini Live realtime front (`gemini`, `realtime`, `server-workers`): `REALTIME_FRONT=gemini`
  with `GEMINI_API_KEY`; OpenAI remains the default front.

### Verified
- Live gates green: CF cascade barge-in (interrupt ≤2.1 s via provider events, ~0.6 s browser
  local VAD), Studio headless-Chrome fake-mic e2e, mid-call drop/resume, CF Twilio-protocol
  smoke, and the two-host Fly synthetic-carrier run (twilio/telnyx/smartpbx, 0.0 s stereo
  overlap, quality gates passed).

## 2.0.0

Internal baseline (unpublished): Syrinx Kernel v2 — PipelineBus routing, plugin contract,
categorized errors, idle timeout, mode switching, playout-clock turn-taking (G1–G12 hardening),
stereo call recorder, kuralle reasoner bridge, Cloudflare Workers edge (DO + R2), telephony
transports (Twilio/Telnyx/SmartPBX), bi-model realtime bridge.
