# Changelog

All `@kuralle-syrinx/*` packages are versioned and released in lockstep.

## Unreleased

**Metering — usage → dollars → cap.** The load-bearing "fitting" that keeps Syrinx an embeddable
engine while making it straightforward to later wrap as a billed hosted API (AssemblyAI-style):
per-stage resource consumption is recorded where it happens, priced by a versioned catalog, and
bounded by a spend guard. Additive and opt-in; no breaking changes. The engine emits the signals —
billing, dashboards, and quotas are downstream consumers.

### Added — usage seam
- **`core`**: `UsageRecordedPacket` — one billable unit recorded at its source, `stage: "llm" | "stt" | "tts"`
  with `provider`/`model` and the stage-appropriate quantity (LLM tokens incl. cached/reasoning; STT
  `audioSeconds`; TTS `characters`). `VoiceAgentSession` accumulates these into an end-of-session `usage`
  manifest and exports each as a counter through `MetricsExporter.observeCounter`, tagged
  **low-cardinality only** (provider/model/stage — never sessionId/speechId, matching LiveKit's cap).
- **`core` / `aisdk` / `realtime`**: `ReasonerUsage` on `ReasoningPart.finish`; the LLM producer wired on
  both fronts — cascade (AI SDK `finish.totalUsage`, per-pass) and native realtime (OpenAI
  `response.done` usage).

### Added — usage producers (STT + TTS)
- **`deepgram` / `cartesia` / `openai-tts`**: the STT (audio-seconds) and TTS (characters) producers,
  completing the three-stage manifest (only the LLM stage was wired before). STT emits at the
  **final-transcript funnel** (`pushResult`), so usage is recorded under **both** Deepgram-owned
  endpointing (`emit_eos_on_final: true`) **and** smart-turn endpointing (`emit_eos_on_final: false`,
  where Deepgram never signals turn-complete); billing is **incremental per is_final segment**, so a
  multi-segment turn sums to its true audio duration without double-counting. TTS bills the synthesized
  character count and does **not** charge cancelled/failed (barged) turns. Cartesia routes its usage
  through the existing `tts-core` `sideband` event, not a new channel.
- Live-verified: a single cascade turn (smart-turn endpointing) exports all three stages —
  `usage.audioSeconds` (deepgram/nova-3), `usage.inputTokens`/`outputTokens` (openai/gpt-4.1-mini),
  `usage.characters` (cartesia/sonic-3).

### Added — pricing + spend cap
- **`core`**: `pricing.ts` — a versioned, per-modality `PriceCatalog` (`source` + `version` stamp;
  STT `$/audio-second`, LLM `$/1M` input/output/cached tokens, TTS `$/1M` characters) with a
  `DEFAULT_PRICE_CATALOG` of current public list prices; local/self-hosted models are explicitly
  zero-cost. `costOf(usage, catalog)` returns a typed **`unpriced`** result for an unknown
  provider/model rather than a silent `$0`.
- **`core`**: `spend-cap.ts` — `SpendCapGuard` accumulates priced usage with **observe (`record`) and
  control (`check`) separated** so the same usage is never double-counted; the cap latches once on breach
  for the session/provider layer to refuse or fall back. Standalone and fully unit-tested — the session
  wires it in a later change.

**Observability seams — build any dashboard on the engine's signals.** The engine emits structured,
low-cardinality signals; billing, dashboards (Lens-style), and evals are downstream consumers. Additive.

### Added — two-layer observability + localization
- **`core`**: `MetricTags.layer` (`"infrastructure" | "conversation"`) set on every metric emit, and
  `localizeTurn()` composing a per-turn `turn.localization` verdict (infra-breached → conversation-flagged
  → none) so a consumer can route "was this a system failure or an agent failure?" without collapsing the
  dual-dimension (task-success vs satisfaction) scores into one number.

### Added — acoustic signals as observability
- **`core` / `vap` / `pipecat-smart-turn`**: `AcousticSignalPacket` (`acoustic.signal`:
  prosody / backchannel / interruption / primary_speaker / echo_rejected / cadence), tagged
  `layer: "conversation"` and emitted from the sources Syrinx already computes for turn-taking
  (`PrimarySpeakerGate`, the VAP policy sink, the turn-arbiter, backchannel/cadence). A **signal** surface
  only — sentiment/emotion classification stays a consumer, not baked into core; the VAP-dormant path
  emits no prosody and does not throw.

### Added — surface dropped Kuralle orchestration parts
- **`core` / `kuralle` / `aisdk` / `realtime` / `cf-agents`**: `ReasoningPart` gains an additive
  `control` variant (passthrough for handoff / conversation-outcome / escalation / flow-transition) and a
  terminal `blocked` variant (moderation); `from-kuralle` now maps these instead of dropping them at
  `default`, and surfaces them through the existing `delegate.result` host channel. **Correctness fix:** a
  `safety-blocked` turn now **speaks** its `userFacingMessage` (cascade emits `llm.delta`/`llm.done` →
  TTS; realtime injects a tool result) and ends the turn cleanly, instead of degrading into the generic
  "stream ended without a done part" error. Both `ReasoningPart` consumers (`ReasoningBridge`,
  `RealtimeBridge`) handle the new variants; the wrapper reasoners (`HedgedReasoner`, `RoutingReasoner`)
  pass them through.

### Added — silent context-injection seam (background-observer guardrails)
- **`core` / `aisdk` / `realtime`**: `inject.message` gains `mode?: "speak" | "context"` (default `speak`,
  back-compat) and `Reasoner.injectContext?(text)`, so a background observer LLM can bias the agent's
  **next** turn without blocking or being spoken (LiveKit's observer-guardrail pattern). Cascade
  (`ReasoningBridge`) appends an additive `{role:"system"}` message to history and keeps it **out of the
  durable session store** (transient steering, not durable history); the base system prompt is never
  replaced. Realtime handles the provider asymmetry: OpenAI injects a system `conversation.item.create`;
  Gemini Live (which drops system/developer roles) falls back to a `role:"user"`, `turnComplete:false`
  context turn — documented, never a silent no-op. The observer loop ships as an example
  (`examples/02-hello-voice-headless`, single-flight + per-violation dedup), proving the seam without
  baking policy into core.

### Added — phone-line turn quality
- **`pipecat-smart-turn`**: `fuseEndpointDecision` gains a **minimum-speech** third condition
  (`minSpeechMs`, default `0` = unchanged) — endpoint only when acoustic AND semantic AND enough real
  speech, so a brief cough/noise burst no longer trips a false turn end (the AssemblyAI/LiveKit 3-way AND).
  Per-turn voiced-ms is accumulated in the EOS plugin and threaded through the interaction policy.
- **`core`**: opt-in **outbound loudness normalization** (`audio/loudness.ts` `normalizeLoudness` —
  running-RMS gain toward a target, slew-limited, with an exponential soft-limit that asymptotes below the
  Int16 ceiling so it never hard-clips or wraps), wired in `handleTtsAudio` via an `outboundLoudness`
  session config. **Default off** (byte-identical passthrough); telephony legs benefit, the browser leg
  (getUserMedia AEC/gain) is unaffected. The engine-level, provider-agnostic piece only — number
  verbalization / pronunciation / SSML remain prompt/provider concerns, out of scope.

### Added — mid-stream STT reconfigure seam (vendor-agnostic)
- **`core` / `deepgram`**: `SttReconfigure` / `SttReconfigurePartial` — a vendor-agnostic seam for
  per-turn STT reconfiguration (keyterms, end-of-turn thresholds, language hints) that normalizes the
  differing vendor wire shapes (Deepgram Flux `Configure`, AssemblyAI `UpdateConfiguration`,
  Speechmatics `SetRecognitionConfig`) behind one interface an `InteractionPolicy` can actuate.
  `DeepgramFluxSTTPlugin.reconfigure()` implements it via the Flux in-band `Configure` control message —
  no reconnect, live-verified (`ConfigureSuccess` ~234 ms) — surfacing `ConfigureSuccess`/`ConfigureFailure`
  as metrics. **Scope note:** per-turn STT reconfigure is a commodity capability (LiveKit `stt.update_options`,
  Pipecat `STTUpdateSettingsFrame`, AssemblyAI `agent_context` all ship it), **not a differentiator** —
  this lands the seam + one implementation; the actuating policy layer is intentionally deferred.

## 4.2.0 — 2026-07-11

Additive, lockstep. The "vNext" batch: model-agnostic full-duplex turn-taking, half-cascade
(text-only realtime front + Syrinx TTS for correct multilingual audio), reasoner-latency
levers, and a shared Incremental-Unit substrate. Two new packages. No breaking changes to the
published 4.1.0 API — all new seams and opt-in features. Grounded in `docs/rfc-*` (interaction-policy
seam, half-cascade, reasoner-latency, incremental-unit substrate).

### Added — packages
- **`@kuralle-syrinx/openai-tts`** (new) — generic OpenAI-compatible streaming TTS plugin
  (`OpenAICompatibleTTSPlugin`) for any `POST /v1/audio/speech` endpoint via `base_url` + `extra_body`,
  mirroring `livekit-plugins-openai` / Pipecat `OpenAITTSService`. Defaults to OpenAI's own TTS
  (`gpt-4o-mini-tts`). Pitch-preserving `tempo` control (streaming WSOLA). Self-hosted/proprietary
  endpoints (e.g. a Sinhala model) are documented config, not baked-in factories.
- **`@kuralle-syrinx/vap`** (new) — Voice-Activity-Projection interaction policy (`VapInteractionPolicy`)
  with stateful licensed predictors (DualTurn ONNX, Kyoto VAP) and a Workers variant. Dormant-but-armed
  behind the InteractionPolicy seam (C6 eval: the cheap Silero+SmartTurn stack still wins — see
  `docs/c6-vap-eval-results.md`).

### Added — interaction policy (full-duplex turn-taking)
- **`core`**: `InteractionPolicy` seam + `InteractionCoordinator` collapsing the endpointing owners into
  one model-agnostic controller; `RuleBasedInteractionPolicy` (behavior-preserving default),
  `DeferInteractionPolicy` (full-duplex observe-only); session `interactionPolicy` injection with
  `audio_frame`/`playout_tick` feeds; LiveKit-style `confidenceToWaitMs` curve; backchannel cue layer.
- **`pipecat-smart-turn`**: `SmartTurnInteractionPolicy` — Silero + Smart Turn v3 + semantic fusion as a
  first-class injectable policy.

### Added — half-cascade (RFC docs/rfc-half-cascade.md)
- **`realtime`**: text-only modality — `response.output_text.delta/.done` → transcript events,
  `caps.supportsTextOnlyModality`; `RealtimeBridge` `textOnly` routing (front text →
  `llm.delta → segmenter → tts.text`, provider audio suppressed, TTS plugin owns `tts.end`); and
  `syrinxTurns` + `adapter.requestResponse()` so Syrinx owns turn detection with server VAD off.
  Live-verified English + Sinhala, single- and multi-turn, with cross-turn context.

### Added — reasoner latency (RFC docs/rfc-reasoner-latency.md)
- **`core`**: `HedgedReasoner` (threshold-triggered backup, commit-on-first-part) and `RoutingReasoner`
  (heuristic fast/deep routing) at the `Reasoner` seam; plain-Reasoner path byte-identical.

### Added — Incremental-Unit substrate (Phase 0, RFC docs/rfc-incremental-unit-substrate.md)
- **`core`**: `InMemoryIuLedger` + `IncrementalUnit` — one commit/revoke primitive; speculative gen and
  assistant-side heard-prefix re-expressed on the ledger (behavior-preserving); a ledger leak bounded.

### Fixed
- **`tts-core`**: finish-timeout is now an **inactivity watchdog** (reschedules on audio) instead of a
  fixed timer from flush — long TTS turns (fast realtime front dumping full text) no longer truncate
  mid-sentence.
- **`core`/`server-websocket`**: user `audio_received` carries its true `sampleRateHz` (was hardcoded
  16 kHz) so learned policies resample correctly; a policy-committed `take_turn` with only interim STT no
  longer silently drops the turn; `stop()` no longer leaks an interaction-playout timer.

### Notes
- `@kuralle-syrinx/openai-tts` supersedes the never-published bespoke `zeta-tts` (reshaped, not shipped).
- Zeta/Sinhala production still needs Modal Flash keep-warm (deferred deploy gate; see rfc-half-cascade C5).

## 4.1.0 — 2026-07-03

Additive. Two efforts: **cascade refinements** adopted from the production field's published
playbook (LiveKit preemptive generation, Deepgram Flux, Sierra's latency/ASR posts), and
**background audio** (ambient bed / thinking sound / comfort noise / ducking) modeled on LiveKit
`BackgroundAudioPlayer` + Pipecat `SoundfileMixer`.

### Added
- `deepgram`: **`DeepgramFluxSTTPlugin`** — turn-aware STT over the Flux v2 API (one model does
  transcription AND end-of-turn). TurnInfo state machine → bus: `StartOfTurn`→barge-in signal,
  `Update`→interim, `EagerEndOfTurn`→`eos.interim`, `TurnResumed`→`eos.retracted`,
  `EndOfTurn`→final + `eos.turn_complete`. Plain WebSocket, so **semantic end-of-turn now works
  on the Workers edge cascade** (where local ONNX endpointers can't run). Config:
  `eot_threshold` (0.7), `eager_eot_threshold` (unset = eager mode off), `eot_timeout_ms`
  (5000), `keyterm`, `language_hint`. Live-verified (`smoke:flux-live`).
- `core`: **`eos.retracted` packet** — retraction of a prior `eos.interim` for the same context
  (Flux `TurnResumed` semantics); consumers doing speculative work off `eos.interim` must cancel.
- `aisdk`: **opt-in speculative generation** — `new ReasoningBridge(reasoner, { speculative:
  true })` (or `speculative: true` on a cf-agents cascaded pipeline). Starts the LLM on
  `eos.interim` with every side effect buffered; a matching `eos.turn_complete` promotes the
  draft as-is (one LLM call — TTFT paid during the endpoint-confirmation window), a mismatch
  regenerates, retraction/barge-in discards. Drafts never consume suspended-run pointers.
  Live A/B (`smoke:flux-speculative-ab`): saving = min(LLM TTFT, eager lead) — seconds on
  hesitant speakers, ~100ms on quick utterances at zero extra LLM calls. Default OFF
  (unconfirmed endpoints cost extra LLM calls; Deepgram measures +50–70%).
- `core`: **`turn_latency` session event** — honest per-turn latency decomposition
  `{ ttfaMs, eouDelayMs?, llmTtftMs?, ttsTtfbMs?, fillerUsed }`, anchored to the real end of user
  speech, emitted once at first TTS audio; interrupted turns emit nothing; filler-masked turns
  are flagged so a masked turn is never mistaken for a fast one.
- `deepgram`: **`keyterm`** passthrough on the nova-3 STT plugin (repeatable query param) —
  biases recognition toward domain terms (misheard names/codes are the #1 production failure).
- `server-websocket`: **background audio** — `BackgroundAudioMixer` (runtime-neutral; exported
  from the root and `/edge` subpath): looped ambient bed mixed under assistant speech (ducked,
  `duckWhileSpeaking` default 0.5) on all four outbound paths (Node telephony + Node browser +
  edge browser + edge-twilio); **idle comfort-noise frames between turns on edge-twilio** (pure
  digital silence on a phone line reads as "the call died"); a **thinking loop** driven by the
  G3 `tool_call_cue`s; **equal-power `fadeMs`** (default 250ms) on bed start and thinking
  episode entry/exit. Sources are raw mono PCM16, looped and resampled to the wire rate. The
  recorder always keeps the clean assistant track. `withVoice({ backgroundAudio })` passthrough
  on both transports. Ear-verified via a live listen demo (`smoke:background-audio-listen`).

### Fixed
- Example flux smoke scripts: proper packet types (typecheck).

## 4.0.0 — 2026-07-03

Breaking, multi-package. Two bodies of work land together. The **voice-engine correctness sweep**
fixes every P0–P3 from the critical review against the new `docs/voice-engine-behavior-spec.md`:
turn 2 of a phone call works, barge-in truncates memory to what was actually heard, opus plays at
the right speed, and a turn failure never kills the call. The **bi-model delegate seam**
(`docs/rfc-bimodel-delegate-seam.md`) makes the **Responder-Thinker** pattern — a fast realtime
front model delegating to an async reasoner — a first-class primitive: observable (delegate
packets/events/hooks), faithful (structured result envelope), felt (typed thinking cues on the
wire), and durable (reasoner history survives Durable Object eviction).

### Breaking
- `realtime`: the delegate tool result injected into the front model is now a structured JSON
  envelope by default — `{ response_text, require_repeat_verbatim: true, render? }` (OpenAI's
  Tool Output Formatting field names) — so realtime fronts voice the reasoner's answer faithfully
  instead of paraphrasing it. `RealtimeBridgeOptions.toolResultFormat: "string"` restores the raw
  string; `renderDirective` populates `render`. Bus packets (`llm.tool_result`,
  `delegate.result`) keep the **raw** answer. Exported `DelegateResultEnvelope`.
- `cf-agents`: `withVoice` gains `durableHistory`, default **on** — conversation history (and the
  Gemini Live resume handle) persists in the Agent's DO-SQLite and is re-seeded into the reasoner
  after isolate eviction. Set `durableHistory: false` to opt out of the new tables/behavior.
- `server-websocket`: the Node telephony adapters (`twilio`, `telnyx`, `smartpbx`) now rotate a
  per-turn `contextId` (`<base>-t<n>`) on `eos.turn_complete` and emit `turn.change` (shared
  `installTelephonyTurnRotation`) — THE fix for the agent going deaf/mute after turn 1 of a phone
  call (STT/TTS retire a contextId once its turn completes). Stable-per-call contextId reuse is
  unsupported by design.
- `server-websocket`: opus wire-format labels corrected. Uplink opus is labelled at the engine
  rate post-decode (the second resample was 3×-speeding STT input); downlink opus frames are
  labelled at the 48 kHz codec rate (was 16 kHz → clients played 3× slow). Consumers pinned to the
  buggy shapes must update.
- `aisdk`: a turn failure never kills the call. A `length` finish accepts the truncated reply; any
  other non-`stop` finish emits a **recoverable** `llm.error` (fallback line spoken, session stays
  up). The throw-based `validateFinalFinishReason` is removed.
- Session and turn ids are now `crypto.randomUUID()` (were `Math.random`-derived); anything
  parsing the old id shape must relax.

### Added
- **Delegate observability (G2)**: `delegate.query` / `delegate.result` Background packets
  (`delegate.result` is a self-contained Q&A pair: `query`, `answer`, `durationMs`, `grounded`,
  `toolId?`, `toolName?`; `grounded` = the reasoner stream surfaced ≥1 tool-result part), emitted
  on both the realtime (`RealtimeBridge`) and cascade (`ReasoningBridge`) paths; surfaced as
  `delegate_query` / `delegate_result` session events; `withVoice` gains `onDelegateQuery` /
  `onDelegateResult` hooks (`DelegateQueryContext<Env>` / `DelegateResultContext<Env>` include
  `connection` **and `env`**; a throwing hook never affects the call).
- **Typed thinking cues (G3)**: `VoiceAgentSession` emits `tool_call_cue` with `phase:
  "started" | "delayed" | "complete" | "failed"` (config `delayCueAfterMs`, default 2000 ms;
  `failed` fires on error, barge-in, and superseding turns). Both transports send
  `tool_call_started` / `tool_call_delayed` / `tool_call_complete` / `tool_call_failed` wire
  messages — the Workers edge previously sent **nothing** for tool calls — and
  `browser-client` parses all four. `withVoice` threads `delayCueAfterMs`.
- **Durable reasoner sessions (G4)**: `core` gains `ReasonerSessionStore` +
  `InMemoryReasonerSessionStore` (snapshot semantics — barge-in truncation rewrites persist);
  `ReasoningBridge` accepts `{ sessionStore, sessionId }` (load-only on init — no double-answer);
  `cf-agents` ships `SqliteReasonerSessionStore` over DO-SQLite and `withVoice` exposes
  `ctx.resume = { history, providerHandle? }` to pipeline factories.
- **Realtime resume**: `RealtimeAdapter.caps.supportsNativeResume`; OpenAI-compatible adapters take
  `resumeHistory` and replay it as `conversation.item.create` after every (re)connect — never
  `response.create`; Gemini Live always enables `sessionResumption`, accepts a prior
  `sessionResumptionHandle`, and surfaces new handles as `realtime.resumption_handle` Background
  packets. `kuralle`: `fromKuralleRuntime` seeds prior turns via `historyDelta` into an **empty**
  kuralle session only (fresh isolate), never a populated one.
- `server-websocket`: `authorize` hook on the WS host (reject → 4401) and a runtime-neutral
  `validateTwilioSignature` (Web Crypto HMAC-SHA1).
- Barge-in heard-context truncation wired end-to-end: `browser-client` reports `playout_progress`
  from the jitter buffer's real played-out position, and the Node server now accepts it (edge
  already did) — history truncates to what the user actually heard.
- Thinking-phase barge-in: a client interrupt during the reasoner TTFT gap (before any audio)
  aborts the in-flight turn.
- Deepgram STT: `utterance_end_ms` gap-based backstop (completes a wedged turn on noisy lines
  where `speech_final` never fires); enabled on the edge cascade.
- Docs: the Responder-Thinker primitive is named and documented (`realtime` README, `cf-agents`
  README, building-a-voice-agent guide); `docs/voice-engine-behavior-spec.md` and
  `docs/rfc-bimodel-delegate-seam.md` are committed.

### Changed
- `server-websocket` (edge): default `endpointing` 300 → 500 ms (stops mid-utterance cutoffs;
  negligible vs the LLM-dominated voice-to-voice budget).
- `core`: a backchannel ("yeah", "mhm", …) while the assistant speaks neither cancels the answer
  nor spawns a second response (exported `isBackchannel`; English-only for now).
- `core`: sentence segmenter is abbreviation/decimal-aware ("Dr.", "$12.", "e.g." no longer
  split) and caches `Intl.Segmenter`.

### Fixed
- `core`: a superseding turn cancels any still-active prior-turn TTS (false-EOS overlap) — stale
  audio never plays over the user.
- `core`: `allPackets` / `debugEvents` drop-on-unread, so a default deployment (no recorder or
  debug reader) no longer retains the whole call in memory.
- `core`: the idle timer is anchored to real playout end (can't fire mid-speech) and idle
  escalation resets on user engagement.
- `server-websocket` (edge-twilio): session-lease leak on hangup/startup-race fixed; multi-turn
  telephony covered by tests.
- `cf-agents`: the R2 recorder streams via multipart upload — DO memory is bounded regardless of
  call length.
- `realtime`: the delegate runs off the event pump, and the provider session is re-configured on
  reconnect.
- `gemini`: TTS uses per-context abort controllers (barge-in no longer aborts the wrong turn).
- `deepgram`/`tts-core`: retired-context sets are bounded (no longer leak one entry per turn on
  long calls).

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
