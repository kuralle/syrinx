# Changelog

All `@kuralle-syrinx/*` packages are versioned and released in lockstep.

## Unreleased

### Changed
- `kuralle`: dropped the dead `streamFromKuralle` export from the package entry point. It had no
  consumers — `fromKuralleRuntime` wraps it internally. The function itself is unchanged.

### Fixed
- `realtime`: the delegate Reasoner's query argument name is now configurable via
  `RealtimeBridgeOptions.delegateQueryArg` (default `"query"`). A delegate `tool_call` whose
  arguments lack a string query now emits a clear recoverable `llm.error` instead of silently
  reasoning over an empty string.

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
