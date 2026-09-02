# Changelog

All `@kuralle-syrinx/*` packages are versioned and released in lockstep.

## Unreleased

### Breaking — `core`: a handler's dispatch mode is now declared at registration

`PipelineBus.on(kind, handler)` no longer silently awaits an `async` handler in
registration order. An `async` handler (or one that returns a `Promise`) must now
declare `{ concurrent: true }` or `{ serial: true }` as a third argument — omitting
it is a **compile error**, not a runtime warning. This is the fix for the class of
bug the dev-only `SLOW_HANDLER_WARN_MS` guard (4.6.x) could only report after the
fact: on Cloudflare Workers/Durable Objects, an awaited non-concurrent handler defers
delivery of the provider's inbound socket events for the whole await, so TTS audio
stops being produced for that duration (measured live: `main` stalled 3/6 runs with
gaps up to 10s, `concurrent` 0/6). Third-party plugins with an `async` handler
registered with no third argument will fail to build; add `{ concurrent: true }`
(the default remedy — fire-and-forget, never parks the drain loop) or `{ serial:
true }` if the handler genuinely needs registration-order awaiting. A sync handler
is unaffected. The old loose `{ concurrent: false }` also stops compiling, and a
third-party implementation of the `PipelineBus` interface must adopt the new `on`
signature. New exported type `DispatchMode`.

### Changed — the `metrics` wire message now shares its field names with `turn_latency`

The `metrics` websocket message (`server-websocket`) dropped `sttMs`/`llmTTFTMs`/`ttsTTFBMs`/`e2eMs` in favor of the `turn_latency` event's own names (`ttfaMs`, `anchor`, `llmTtftMs`, `ttsTtfbMs`, ...), copied verbatim instead of recomputed — a dashboard can now join the two messages on `turnId`.

`syrinx turn`'s `metrics.json` output renamed `llmTTFTMs`/`ttsTTFBMs` to `llmTtftMs`/`ttsTtfbMs` to match.

### Breaking — `cf-agents`: `withVoice` takes `stt` / `tts` / `realtime` as peer fields

`withVoice(Agent, { pipeline: { kind: "realtime" | "cascaded", … } })` is gone. The
voice stages are peer fields on `WithVoiceOptions` — `realtime`, `stt`, `tts`, `vad`,
`eos` — and the shape is derived from which are populated: `realtime` alone is a
realtime front, `realtime` + `tts` is a half-cascade (text-only front, Syrinx TTS),
`stt` + `tts` is a cascade. Any other combination throws naming the field at fault.
The shape-specific knobs (`delegateToolName`, `toolResultFormat`, `renderDirective`,
`endpointingOwner`, `sttForceFinalizeTimeoutMs`, `speculative`) moved up one level
with their names unchanged. `RealtimePipeline`, `CascadedPipeline` and
`VoicePipeline` are deleted; `VoicePipelineFields`, `VoiceShape`, `resolveVoiceShape` and
`CascadedEndpointingOwner` are exported instead. A knob supplied to a shape it does not
apply to (a cascade-only `vad`/`eos`/`endpointingOwner`/`sttForceFinalizeTimeoutMs`/
`speculative` on a realtime front, or `delegateToolName`/`toolResultFormat`/
`renderDirective` on a cascade) throws naming the field. No alias is kept.

### Added — `realtime`: NON_BLOCKING delegate dispatch on `RealtimeBridge`

`RealtimeBridgeOptions.delegateBehavior: "NON_BLOCKING"` (default `"BLOCKING"`), paired with
`delegateAnswerScheduling: "INTERRUPT" | "WHEN_IDLE"` and `delegateAckScheduling: "SILENT" |
"WHEN_IDLE" | "INTERRUPT"` (default `"WHEN_IDLE"`) — on a front whose `caps.supportsToolBehavior`
is true (Gemini Live), the delegate tool call acks immediately instead of holding the turn, the
front tells the caller it is checking, and the reasoner's answer is injected as a terminal tool
result when it arrives. Front tools (`onFrontToolCall`) now run off the serial event pump.

## 4.6.3 — 2026-07-27

### Fixed — the Testing page told readers to install the internal fakes

`reference/testing.md` opened Level 1 with `npm install --save-dev
@kuralle-syrinx/test`, presenting the fake set Syrinx uses on its own unit tests as
the recommended starting point. That instruction is gone. Level 1 now says plainly
what the fakes are for, and that Level 2 — a real fixture turn against real
providers — is the level that actually checks your agent.

The page's code example was always correct; only the framing was wrong.

## 4.6.2 — 2026-07-27

### Fixed — stop presenting the internal fakes as the way to test an agent

`@kuralle-syrinx/test` is the scripted fake set Syrinx uses on **its own** unit
tests. Its README (added in 4.6.0) read as a general recommendation, which it is not:
the fakes prove wiring — a turn advances, an interruption is handled, an error does
not kill the session — and cannot tell you whether your agent understood the caller,
because the transcript is one you wrote.

The README now says what the package is for and points at the real path: capture a
fixture in the Studio, replay it with `syrinx turn`, which runs your actual pipeline
against real providers and fails on transcript drift. The Testing reference page
carries the same steer.

## 4.6.1 — 2026-07-27

### Fixed — a README example that could not work

The `@kuralle-syrinx/test` README showed the fakes taking constructor arguments:

```ts
new FakeSTT({ script: ['…'] })      // wrong — the argument is ignored
new FakeBridge({ reply: '…' })
```

They take **none**. Their scripts arrive through the session's `plugins` config, like
every other plugin's `api_key`, and the real keys are `scriptedEvents` /
`scriptedAudioBatches` / `scriptedSpeechProbabilities`. As written, the fakes would
silently do nothing and the reader would have no idea why.

I invented those arguments instead of reading the constructors — the same failure this
repo's docs had before, now caught by checking every README example against the source.
The corrected version is taken from a passing test (`cli/src/turn-runner.test.ts`)
rather than written fresh.

Audited the rest the same way: every imported symbol across all 12 new READMEs
resolves, and the config keys in the Cartesia, Deepgram, recorder and S3 examples match
what the code actually reads.

## 4.6.0 — 2026-07-27

### Added — recordings can land in any S3-compatible bucket

`S3ObjectStore` speaks the S3 REST API, so a call recording can be written to AWS S3,
R2's S3 endpoint, MinIO, Backblaze B2 or Wasabi — not only the R2 Workers binding.

Introduced behind a new `ObjectStore` seam rather than as a second recorder. Everything
hard in the existing one is storage-agnostic — wall-clock placement, the clock-skew gap
cap, the 64 KiB silence slicing that fixed an OOM, the deferred part 1 whose WAV header
needs a length known only at the end. Two copies of that would drift.

Signs SigV4 over `fetch` via `aws4fetch` (~65 KB) rather than bundling
`@aws-sdk/client-s3`: this runs inside a Worker where bundle size is the constraint.

**Not yet verified against a live S3 endpoint** — R2's S3 credentials cannot be minted
with `wrangler r2`, and no local S3 server was available. The wire format is covered by
tests through an injected `fetch`. The R2 binding path *has* been verified live.

### Fixed — found by testing against a real R2 bucket

- **Storage class was never applied to multipart uploads.** It is fixed at
  `createMultipartUpload`; setting it on the parts does nothing. So every stem over
  5 MiB silently stayed `Standard` while the small ones honoured the setting — exactly
  the large objects the option exists to save money on. A mocked bucket could not have
  caught this.
- **A failed finalize leaked the multipart upload.** `finalize()` had no error handling
  and the part-upload chain was unguarded. An abandoned upload is billed until R2
  auto-aborts it at 7 days. It now aborts what it opened, then rethrows the original
  cause rather than masking it.
- **A clock-skew gap could allocate unbounded.** Chunks are placed at their wall-clock
  offset and the intervening silence is materialised; a bad `startedAtMs` or a resumed
  DO whose clock moved makes that gap absurd. Found by killing a vitest worker with
  `ERR_IPC_CHANNEL_CLOSED`. Capped at 10 minutes per gap, and the stem is flagged
  `clockSkewed` in the manifest — a capped gap means the timeline is shorter than wall
  clock claims, so alignment cannot be trusted and must not be silent.

### Added — the recorder is attachable in one call, and documented

`attachRecorder(session, { outputDir })` replaces three coordinated steps that were
only discoverable by reading the source.

Eleven published packages had **no README at all** and rendered blank npm pages:
recorder, cartesia, deepgram, gemini, google, server-websocket, server-workers,
silero-vad, test, tts-core, ws. All 27 packages have one now, each written from that
package's real exports rather than its name. New docs page: **Recording a call**.

Recordings are verified by transcribing each channel with an independent STT rather
than by checking levels — levels prove a file is not empty but cannot catch a channel
swap or TTS speaking text the reasoner never produced.

## 4.5.1 — 2026-07-26

### Fixed

- The generated `AGENTS.md` still told you `--agent` on a `.ts` module needs `tsx` because of
  raw TypeScript under `node_modules`. 4.5.0 removed that. Measured the new boundary rather
  than guessing: a **single-file** `.ts` agent now runs under plain `node`; a **multi-file** one
  does not, because TypeScript imports `./greeting.js` for `greeting.ts` and Node looks for a
  literal `.js`. Generated scripts keep using `tsx` — correct, since you will add files — but
  the stated reason is now the real one.

## 4.5.0 — 2026-07-26

### Fixed — packages now import on plain Node

`npm i @kuralle-syrinx/core` then `import("@kuralle-syrinx/core")` failed on plain Node with
*"Stripping types is currently unsupported for files under node_modules"*. This was the top
open packaging defect and the first thing an evaluator hit.

The diagnosis had been wrong. It was never that we ship TypeScript — `@livekit/agents` ships
266 `.ts` files alongside its JS and imports fine. The difference is one line: their `main`
points at `dist/index.js`; ours pointed **at** `./src/index.ts`, so Node was asked to resolve
a `.ts` file inside `node_modules`, which it refuses to do.

- Every publishable package now builds to `dist` (JS + `.d.ts`) and declares
  `publishConfig.main/types/exports` pointing there. pnpm swaps those in at publish time, so
  **the workspace still resolves to `src`** — no build step in the dev loop, no change to how
  tests or typecheck run.
- `src/` still ships alongside `dist/`, exactly as LiveKit does. Nothing resolves to it.
- All 27 subpath exports preserved and verified (`core/audio`, `browser-client/record`,
  `ws/node`, `ws/workers`, `server-websocket/edge`, `grok/realtime`, and the rest).
- `@kuralle-syrinx/cli` gained a real `./turn-runner` build; it was still exporting raw TS.

**Verified**: all 27 packages packed, installed into a clean project, and imported on plain
Node — 23 of 23 library packages import cleanly. (`server-workers` imports `cloudflare:workers`
and is Workers-only by design; `cli` is a `bin` with no root export.)

### Fixed — undeclared ambient types

`core` and 21 other packages used Node/web globals (`TextEncoder`, `ReadableStream`,
`performance`) without declaring `@types/node`. `pnpm -r typecheck` passed only because test
files happened to drag those types in; excluding tests from the build surfaced it immediately.

## 4.4.1 — 2026-07-26

### Fixed — a scaffolded project now runs out of the box

Found by doing what an evaluator does: `npx create-syrinx-agent@4.4.0` into a temp
directory, `npm install`, and run the checks it ships with. Five defects, all on the
first-five-minutes path, none visible from reading the code.

- **`check:turn` could not run at all.** It invoked `syrinx` directly, and that bin runs
  under plain `node`: a `.ts` `--agent` target importing any Syrinx package resolves to raw
  TypeScript under `node_modules`, which Node refuses to strip. Both generated checks now go
  through `tsx`.
- **The default check could never pass.** It replayed a generated 0.5 s *silence* WAV — no
  speech, so no transcript, so it could only ever time out. A check that ships red teaches
  you to ignore it. The default is now `check:text` (a typed turn, no recording needed);
  `check:turn` remains for a fixture you record in the Studio, where it asserts the
  transcript and fails on drift.
- **`.env` was never read.** The project shipped a `.env.example`, you made a `.env` from it,
  and nothing loaded it — every provider died on a missing `api_key`.
- **Generated projects pinned `^4.3.0`** from a frozen literal, so every future release would
  scaffold against an ever-staler floor. It follows the generator's own version now, with a
  test asserting the two cannot drift — they already had.
- **`mergeImports` silently dropped malformed entries**, behind a comment asserting that
  could not happen. It did: a two-line entry vanished and emitted an agent module missing its
  core import, which failed only in the *generated* project, far from the cause. It throws now.

Verified end to end from a clean temp dir — scaffold, `npm install`, drop in `.env`,
`npm run check:text` → `{"ok":true,"reply":"Hello! How can I assist you today?"}`. No manual
exports, no workarounds.

### Known, unfixed

Packages still ship raw TypeScript, so `import("@kuralle-syrinx/core")` fails on plain Node
("Stripping types is currently unsupported for files under node_modules"). Generated projects
work only because every script runs under `tsx`. That is a workaround the scaffolder papers
over, not a fix, and it remains the top open packaging defect.

## 4.4.0 — 2026-07-26

Local development tooling. Before this release you could build a Syrinx agent and had no
supported way to talk to it, watch what it did, or turn a bad turn into a test. The gap was
a front door, not a capability: the server already sent twenty message types and the studio
rendered five.

### Added — the studio actually drives your agent

- **`examples/02` `dev:server`** replaces `review:studio`, which hard-coded one demo agent.
  Takes `--agent <module>#<export>` and passes the factory straight to
  `createVoiceWebSocketServer`. Refuses to start on an unresolvable export, listing the
  callable exports it found — a dev server that quietly runs a different agent than you asked
  for is worse than one that will not boot. `SYRINX_REVIEW_PORT`/`HOST` → `SYRINX_DEV_PORT`/`HOST`.
- **`browser-client`**: four new Node-safe subpath exports, all pure and DOM-free so a UI can
  be rendered from a recorded fixture in CI rather than a live provider — `./record`
  (`SessionRecord`, a bounded reducer over the message stream), `./agent-state`
  (`idle → listening → endpointing → thinking → speaking → interrupted`, with stall detection),
  `./turn-timeline` (per-turn latency waterfall), `./session-metrics` (nearest-rank
  percentiles, so every number reported is a measurement that occurred), `./turn-recorder`
  (per-turn uplink audio → WAV, bounded, with a pre-roll so the speech onset is not clipped).
- **`apps/studio`**: text mode, connection-failure states that name the cause, microphone
  permission/device states with specific recovery, persistent per-turn agent errors, a session
  info panel, event log, transcript, timeline and metrics — all folded from the one record.
- **`@kuralle-syrinx/cli`** (new): `syrinx turn --in <fixture> --agent <m>#<x>`,
  `syrinx text`, `syrinx doctor`. `--json` is a first-class mode, exit codes are the contract,
  never interactive, never touches a microphone. Depends on `core` and a WAV reader only —
  the agent brings its own providers through the same `--agent` seam.
- **`create-syrinx-agent`** (new): scaffolds a project from composable flags rather than
  enumerated templates. Refuses incoherent combinations, warns on deploy-unverified ones, and
  emits an `AGENTS.md` that states what a coding agent *cannot* verify.
- **Save a turn as a fixture** from the studio — a WAV plus a sidecar carrying the capture
  config, not just the expected transcript. `syrinx turn --in <sidecar>` replays it and exits
  non-zero on drift. Capture in a browser, assert from a CLI.

### Fixed

- **`metrics` never reached the Cloudflare path.** The DO runner never wired
  `TurnMetricsTracker`, so latency panels could not render on Workers at all. Both runtimes now
  emit through one shared builder. Edge playout is client-paced, so `firstAudioPlayedMs` is
  taken from the first client progress report and the `tts.end` floor stands down when a client
  is reporting — otherwise the fix for runtime drift would have reintroduced it.
- **The turn timeline and the metrics panel disagreed**: `textReady → firstAudioByte` was
  labelled "Thinking" in one and "Voice (to first audio)" in the other. Thinking has finished
  by `textReady`.
- **`ready` parity**: Node states `audio.targetFrameDurationMs`, the Workers host does not.
  The session-info panel now surfaces the field (as *not stated* on Cloudflare) instead of
  omitting the row, so the drift canary can see the one divergence that exists.
- **Load-induced test flakes.** Three genuine races fixed at the root — a fixed sleep racing a
  mock's own delay (deepgram), two bursts racing the playout pacer (twilio), and a sleep racing
  Node's timers-before-poll ordering (smartpbx, now proven by a protocol round-trip instead of a
  clock). The larger cause was the runner: 26 packages × a per-package worker pool on 8 cores.
  `workspaceConcurrency: 2` takes the full suite from 3-of-5 green to 8-of-8.

### Added — turn-taking observability

- The **endpointing decision is on the wire**: which owner ended the turn (`provider_stt`,
  `smart_turn`, `timer`) and why (`end_of_speech`, `force_finalized`, `typed`), carried on the
  existing `metrics` message and rendered as a plain-language marker. A typed turn is never
  labelled with a speech owner — nothing endpointed it — and an unknown owner renders as
  unknown rather than a guess.

### Notes

- Additive throughout. No wire-format field changed name, type or meaning.
- `--agent` pointed at a `.ts` module needs `tsx`: Node's type stripping does not do
  TypeScript's `.js`→`.ts` import remapping. Built JS runs under plain `node`.

## 4.3.0 — 2026-07-25

### Added — Telnyx transport on the Cloudflare Workers edge

Closes the Slice F CF gap: G.722/PCMA (and the whole Telnyx media-stream path) now run on the
Workers edge, not only the Node host. Mirrors the existing Twilio-on-Workers wiring.

- **`server-websocket`**: `edge-telnyx.ts` — a Workers-native Telnyx media-stream runner
  (`runTelnyxEdgeWebSocketConnection` / `createTelnyxEdgeWebSocketUpgrade`) on `ManagedSocket`
  (`@kuralle-syrinx/ws/workers`), mirroring `edge-twilio.ts` including its session-lease leak-safety
  (connection-count decrement before `release`, hangup-vs-transient retain, pre-lease buffering).
  New `./edge-telnyx` export.
- **`server-websocket`**: `telnyx-codec.ts` — the per-codec transcode (PCMU/PCMA/G722/L16 select +
  stateful G.722 state + `validateTelnyxStart`) factored out of the Node `telnyx.ts` into a
  **Workers-safe shared module** both the Node host and the Workers runner import (no duplication).
- **`cf-agents`**: `withVoice` gains `transport: "telnyx"`.
- **`server-workers`**: `TelnyxVoiceConversation` Durable Object (`withVoice(Agent,{transport:"telnyx"})`),
  `/telnyx` route + `TELNYX_VOICE_CONVERSATIONS` binding + wrangler migration, and a
  `/telnyx-stream-start` helper that constructs a TeXML `<Stream>` or a Call-Control `streaming_start`
  payload (pure; live POST to the trunk is carrier-gated).
- **Unverified against a live carrier / live Workers deploy:** a real number's `streaming_start`
  reaching `/telnyx` and codec negotiation on a trunk. Unit-verified (server-websocket 273,
  cf-agents 40, server-workers 26; `-r typecheck` 0); the runner + codecs are Workers-safe.

### Added — telephony (Slice F): G.722/PCMA codecs, DTMF-send, call transfer

**Honesty label (non-negotiable):** all three deliverables are **unit-verified only**. There are **no live
carrier credentials** in this build. Do **not** treat green unit tests as certification that DTMF is
decoded by a real IVR, that a trunk negotiates G.722/PCMA, or that a transfer bridges live.
**Carrier-gated / unverified:** real IVR DTMF decode, trunk G.722 negotiation, live transfer bridge.

- **`core/audio`**: `alaw.ts` — ITU-T G.711 A-law (PCMA) encode/decode (`decodeALawToPcm16` /
  `encodePcm16ToALaw`), pure TypedArray, Workers-safe. Unit-tested against known A-law values +
  round-trip fidelity.
- **`core/audio`**: `g722.ts` — stateful G.722 64 kbit/s sub-band ADPCM (16 kHz PCM16 ↔ G.722).
  **Spec-implemented, round-trip-tested, NOT ITU-vector-certified** (authoritative ITU G.722 test
  vectors were not embedded). Pure TypedArray, Workers-safe.
- **`core` packets**: `dtmf.send` (digits `[0-9*#wW]`, pause `w`/`W`) and `call.transfer`
  (`warm` | `cold` | `sip_refer`, optional warm `summary`). Factories: `dtmfSend`, `callTransfer`.
- **`server-websocket`**: Telnyx `validateTelnyxStart` accepts `PCMA`@8k and `G722`@16k; inbound
  decode / outbound encode wired (G.722 keeps 16 kHz for STT — no 8 kHz downsample pitfall).
- **`server-websocket`**: pure carrier command constructors + injectable `fetch()` dispatch
  (`carrier-commands.ts`) for Twilio/Telnyx DTMF-send and transfer. Prefer Call-Control transfer over
  SIP REFER (STIR/SHAKEN attestation B). Warm-handoff summary seam (`WarmTransferSummarizer`). Bus
  wiring for `dtmf.send` / `call.transfer` on Twilio + Telnyx transports. Live HTTP dispatch is
  mockable and **unverified against a live carrier**.
- **CF Workers**: codecs + constructors use only TypedArray / global `fetch` / injected creds (no
  `process.env`, no Node `Buffer` in shared codec/command paths). Telnyx media path lives in
  `server-websocket` (shared with the Node host); the Workers edge currently binds Twilio Media
  Streams via `edge-twilio` (PCMU) — Telnyx G.722/PCMA on Workers requires a Telnyx DO binding that
  is not first-party yet (flagged).

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
- **Full provider coverage:** producers now also wired for **Grok STT/TTS, Gemini TTS, Google STT, and
  Epsilon TTS** — every STT/TTS provider emits `usage.recorded`, so metering is complete regardless of
  provider. STT producers use the same incremental-delta funnel (Grok from provider `duration`; Google
  from `resultEndOffset`/`resultEndTime` with a byte fallback); the tts-core providers (Grok, Epsilon)
  route through the `sideband` event, Gemini via its `emitEnd`. Live-verified on Grok (STT
  `audioSeconds` + TTS `characters`); Epsilon is unit-only (endpoint offline).

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
  as metrics.
- **`deepgram` / `core`**: `DeepgramSTTPlugin` (Nova — the STT every flagship path uses) implements the
  same seam via **reconnect-at-turn-boundary** (Nova has no in-band `Configure`; the LiveKit Nova-3
  pattern): `reconfigure()` updates keyterms + `endpointing` and reconnects through the existing
  `WebSocketConnection.reset()` so the rebuilt URL carries the new params, with replay-on-reconnect
  preserving in-flight audio. Reconnect fires only when a Nova-supported field changed. A `stt.reconfigure`
  bus packet routes through `VoiceAgentSession` to the plugin's `sttReconfigure` — the Syrinx-native
  equivalent of LiveKit's `stt.update_options()` lever. Live-verified (mid-session reconfigure reconnects,
  replays 12 buffered frames, recognition continues). This reaches **functional parity** with
  LiveKit/Pipecat on the flagship STT.
- **`core` / `deepgram`**: `SttReconfigurePartial.language` — a **hard recognition-language switch**
  (distinct from soft `languageHints`), e.g. `"en-US" → "es-ES"` or Nova-3 `"multi"` for code-switch.
  Nova applies it on reconnect (rebuilt URL) and re-stamps `stt.result.language`; Flux (model-fixed
  `flux-general-en`) ignores it and relies on `languageHints`. The enabler for conversation-state-driven
  language biasing (bias the recognizer to the language the dialog expects next). Live-verified
  (mid-session switch to `language=multi` reconnects, recognition continues).
- **Scope note:** per-turn STT reconfigure is a commodity capability (LiveKit `stt.update_options`,
  Pipecat `STTUpdateSettingsFrame`, AssemblyAI `agent_context` all ship it), **not a differentiator** —
  this lands the vendor-agnostic seam + Flux (in-band) and Nova (reconnect) implementations + the actuation
  lever. The *auto-policy* (inferring what to bias / when from the dialogue act) is intentionally deferred —
  nobody ships that either, so deferring it stays at parity.

### Added — package `@kuralle-syrinx/elevenlabs` (TTS + STT)
- **`elevenlabs`** (new): a top-tier vendor with both streaming modalities, on the shared transport.
  - **TTS** — `ElevenLabsTTSPlugin`: multi-context WebSocket (`multi-stream-input`, concurrent contexts
    keyed by `context_id`) on `tts-core`; sends the required `InitializeConnectionMulti` frame before a
    context's first text; base64 audio; `usage.recorded{tts, characters}` **billed on audio received**
    (EL streams audio with `isFinal:null` and a rejected generation returns an empty final that must not
    be billed). `output_format` and a `generation_config` passthrough are dev-configurable, not pinned.
  - **STT** — `ElevenLabsSTTPlugin`: **Scribe v2 Realtime** WebSocket — `partial_transcript` → `stt.interim`,
    `committed_transcript` → `stt.result`; `usage.recorded{stt, audioSeconds}` at the final funnel with
    delta-billing; reuses `@kuralle-syrinx/ws` (reconnect/replay).
  - Real cited pricing in `core/pricing.ts` (Scribe v2 $0.39/hr; Flash/Turbo $50/1M, Multilingual $100/1M chars).
  - **Live-verified end-to-end** (TTS audio + usage, STT transcript + usage). Default voice is a premade
    voice accessible to free API accounts (library voices like Rachel require a paid plan; overridable via `voice_id`).

### Changed — config flexibility (default, never hard-pin)
- **all TTS/STT/Realtime adapters**: audited so every provider knob is dev-overridable with the prior value
  as the default, plus a provider-specific passthrough for fields the adapter doesn't enumerate — extending
  the Gemini-Live fix (`c8aa3fa`, #28/#29/#31/#32) and the `openai-tts` `extra_body` model across the board.
  Highlights: cartesia/gemini `generation_config`; deepgram/grok STT `query_params`; deepgram encoding/container;
  google language_codes/location/recognizer/encoding; realtime `sessionExtra`/`sessionConfig` merged into
  `session.update`. Behavior-preserving; each override is unit-tested.

### Changed — Epsilon → example
- **`epsilon`** package **removed** (dead endpoint). Its code moved into
  `examples/02-hello-voice-headless/src/custom-tts-provider/` as a **"how to build a custom TTS provider"**
  reference (WireProtocol on `tts-core` + `ws`). No package, no dependency edge. Real multi-context WS
  TTS/STT now lives in `@kuralle-syrinx/elevenlabs`.

### Added — package `@kuralle-syrinx/stt-core` (shared STT streaming lifecycle)
- **`stt-core`** (new): the STT counterpart of `tts-core`. `SttWireProtocol` (provider-specific only:
  `encodeFinalize`, `decode(data,isBinary) → SttEvent[]`, optional `isReady()`) + `startStreamingSttSession`,
  which owns the `@kuralle-syrinx/ws` `WebSocketConnection`, `stt.interim`/`stt.result` emit, the
  smart-turn-safe final-transcript funnel, `usage.recorded{stt, audioSeconds}` delta-billing, and finalize —
  so a new STT adapter is just a `SttWireProtocol`. **Grok STT migrated** onto it (behavior-preserving;
  live-verified). It also **buffers pre-handshake audio and flushes it on the ready transition** (rather than
  dropping audio that races ahead of a provider handshake like Grok's `transcript.created`) — no start-of-speech
  loss.
- **`stt-core` extensible base (wave 1):** optional `encodeAudio` / `onOpen` / `encodeReconfigure` seams;
  richer `SttEvent` vocab (`speech_started`, `partial`, `eos_interim`, `eos_retracted`); sent-bytes billing
  fallback when a final has no provider duration (and duration finals advance the byte marker so a later
  no-duration final cannot double-bill); `StreamingSttSession.reconfigure` / `reset`. **ElevenLabs STT**,
  **Google STT**, and **Deepgram Flux STT** migrated onto it (behavior-preserving). Deepgram nova Finalize
  state machine remains a separate wave.
- **`stt-core` / `deepgram` (wave 2 — nova):** optional async-emit seams — `SttProtocolHost` (`attach` /
  `emit` / `reset`), `onFinalizeSent`, `Transport.reset`, and `SttEvent.turn_complete` (eos-only, no
  result/usage). **Deepgram Nova STT** migrated onto the base (behavior-preserving): Finalize
  timeout/fallback/reset, multi-segment accumulation, `speech_final`/`from_finalize` gating, UtteranceEnd
  backstop, and provider-boundary metrics stay in the wire protocol; socket/reconnect/billing/buffer funnel
  is shared.

### Fixed — deterministic type resolution on fresh installs
- **workspace**: pin `undici-types` to 7.x so all three `@types/node` majors in the tree resolve one
  consistent global `Response`. `6.21.0`'s `Response` lacked the newer `bytes()` method, so a fresh
  install could land two conflicting `Response` definitions in one compilation (`TS2741` in
  `@kuralle-syrinx/ws`). Mirrors the existing `undici` runtime override.
- **`server-workers` / `server-workers-mastra`**: two Node tests import `URL` from `node:url`
  (`@cloudflare/workers-types` 4.x dropped the global `new URL(path, base)` overload), keeping
  `-r typecheck` green.

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
