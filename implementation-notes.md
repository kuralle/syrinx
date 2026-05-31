# Syrinx Kernel v2 — Implementation Scratchpad

**Branch:** v2  
**RFC:** rfcs/rfc-syrinx-kernel-v2.md  
**Started:** 2026-05-25

## Kanban

### Backlog

### Doing

### Done
- [x] Chunk 1: Packet types (packets.ts) — 45+ typed packet interfaces, ErrorCategory enum, InitStage enum
- [x] Chunk 2: PipelineBus (pipeline-bus.ts) — 3-channel priority bus, bounded queues, 12 passing tests
- [x] Chunk 3: Init chain (init-chain.ts) — serial init, reverse teardown, InitializationError
- [x] Chunk 4: ConversationEvent (conversation-event.ts) — normalized debug event type + ReadableStream
- [x] Chunk 5: Plugin contract (plugin-contract.ts) — VoicePlugin interface with initialize(bus) + close()
- [x] Chunk 6: Error handler (error-handler.ts) — categorizeSttError, categorizeTtsError, categorizeLlmError
- [x] Chunk 7: Revised VoiceAgentSession (voice-agent-session.ts) — full integration of all modules, legacy event emitter
- [x] Chunk 8: Idle timeout (idle-timeout.ts) — configurable escalation, consecutive backoff, TTS-aware extension
- [x] Chunk 9: Mode switching (mode-switcher.ts) — text↔audio with immediate confirmation + background teardown
- [x] Chunk 10: Plugin updates — DeepgramSTTPlugin, CartesiaTTSPlugin, SileroVADPlugin, AISDKBridgePlugin + FakeSTT/TTS/VAD/Bridge
- [x] Chunk 11: Integration test — pipeline-bus.test.ts with 12 passing tests covering all RFC validation criteria
- [x] Self-review

## Decisions Log

1. **Package structure**: Created monorepo with pnpm workspaces under `packages/`. Each plugin is a separate package (`@asyncdot/voice-stt-deepgram`, etc.) following the existing naming convention from the example's package.json workspace references.

2. **Import extensions**: NodeNext module resolution requires `.js` extensions in import paths. Applied bulk fix with sed.

3. **VoicePacket discriminated unions**: Used string `kind` discriminator instead of TypeScript discriminated unions for handler registration. This allows plugins to push custom packet types without modifying the core type definitions. The `PipelineBus.on()` accepts any packet with a matching `kind` string.

4. **Async dispatch in tests**: `stop()` drains synchronously but handlers may be async. Tests now use `start()` loop + `setTimeout` for reliable async dispatch. Production code uses the async `start()` loop.

5. **InitializationFailedPacket**: Split from extending VoiceErrorPacket to avoid the component type widening issue. Has its own `category`, `cause`, `component` fields.

6. **Debug events via ReadableStream**: Uses `ReadableStream` with `ReadableStreamDefaultController` for the `debugEvents` stream. This is more idiomatic for streaming consumers than EventEmitter.

7. **Plugin config as Record<string, unknown>**: A flat key-value bag with `requireStringConfig()` / `optionalStringConfig()` helpers. Simple, no typed config per plugin (plugin authors extract what they need).

8. **Idle timeout TTS extension**: `extend(ms)` method pauses current timer, restarts with duration + extension. Used during TTS audio playback to prevent timeout while agent is speaking.

9. **Mode switcher audio→text**: Confirms text mode immediately (sends ModeSwitchCompletedPacket), tears down audio components via `Promise.allSettled` in background. User can type immediately — don't wait for WebSocket close.

10. **InjectMessage → synthetic LLM path**: Idle escalation messages are pushed as `LlmDeltaPacket` + `LlmDonePacket` through the normal TTS path. Keeps voice consistent, interruption/abort semantics uniform.

11. **Fake/test providers**: FakeSTT, FakeTTS, FakeVAD, FakeBridge implement VoicePlugin and emit scripted events. No WebSocket connections needed for kernel testing.

## Tradeoffs

- **Monorepo complexity vs. simplicity**: pnpm workspaces add setup complexity but match the existing `workspace:*` dependency pattern in the example code. Single-package would be simpler but would break existing references.

- **String-kind discrimination vs. typed unions**: String `kind` fields require runtime checks in handlers but allow plugin extensibility without core type changes. TypeScript discriminated unions would give compile-time safety but lock the packet vocabulary into the core package.

- **`stop()` synchronous drain**: The RFC specifies `stop()` should drain Critical+Main. The implementation does this synchronously for simplicity. For production, async handlers during drain could be handled with an optional async drain timeout.

## Notes
- The syrinx folder currently only has examples/ — we need to create @asyncdot/voice package structure
- Workspace packages (@asyncdot/voice-*) don't exist locally — will create source stubs
- Deepgram WebSocket key requires streaming credits (402 on ws connection) — noted
- Following RFC Q1-Q4 resolutions: setTimeout drain loop, native bus contract (breaking), Background route for events, synthetic LLM packets for idle messages

---

## WT-05 — Browser Client Reconnect + Resume + Keepalive (2026-05-31)

**Implementation**: `packages/voice-client-browser/src/index.ts`

Key decisions:
- `message` event fires before synthetic `resumed` event so handlers reading `ready.resumed` see it first
- `reconnectAttempt` resets to 0 after a successful open — storm cap is per-outage, not lifetime
- `buildResumeUrl` uses `URL` constructor with fallback for non-standard WebSocket URLs
- `as Uint8Array<ArrayBuffer>` cast on `socket.send()` to satisfy TS6 stricter `ArrayBufferView<ArrayBuffer>` type

**Live smoke artifact**:
`examples/02-hello-voice-headless/test/performance/runs/browser-client-reconnect-2026-05-31T10-40-54-263Z/result.json`

Events observed: `open → message → reconnecting → reconnected → message → resumed → close`
Server confirmed: `resumed: true`, `sessionResumed: true`

## WT-02 — Canonical audio module + anti-aliased resampler (2026-05-31)

**Files created:** `packages/voice/src/audio/{pcm.ts,mulaw.ts,resample.ts,index.ts,audio.test.ts}`
**Files migrated:** `packages/voice-server-websocket/src/{twilio.ts,telnyx.ts,smartpbx.ts,index.ts}` + 5 example scripts

### FIR vs Polyphase decision

**Chosen:** Windowed-sinc FIR, centered evaluation (zero group delay), 127 taps, Hann window.

**Why not polyphase:** Polyphase improves throughput by computing only needed output samples, skipping N−1 intermediate evaluations per decimation factor. For our chunk sizes (160–480 input samples per 20ms frame) the difference is immaterial (<0.1ms). The direct centered FIR is simpler to audit and correct; the interface is unchanged so it can be swapped later if CPU budget matters on embedded targets.

**FIR parameters:**
- Taps: 127 (odd, symmetric) — Hann window provides ~44 dB minimum stopband attenuation
- Window: Hann — well-audited, simple, good stopband/transition balance
- Cutoff: `0.45 × targetSampleRateHz / sourceSampleRateHz` — 5% guard-band below output Nyquist
- Edge handling: centered (zero-phase) formula; boundary samples use available taps only
- Normalization: Σh = 1 for unity DC gain

**Spectral test result (F3 regression lock):** 7 kHz tone at 16 kHz → 8 kHz (aliasing to 1 kHz in naive decimation). Anti-alias output alias ≥40 dB below naive baseline. Test in `packages/voice/src/audio/audio.test.ts` → `anti-alias spectral test (F3)`.

### Smoke results

**Emulator smokes (offline, qualityGate.passed: true):**
- Twilio: `test/performance/runs/twilio-emulator-2026-05-31T10-48-31-687Z`
- Telnyx: `test/performance/runs/telnyx-emulator-2026-05-31T10-48-35-969Z`
- SmartPBX: `test/performance/runs/smartpbx-emulator-g711_ulaw-2026-05-31T10-48-40-598Z`

**Live recorder coherence smoke (`SYRINX_REVIEW_TTS=gemini`):** PASSED — `qualityGate.passed: true`
- Run dir: `test/performance/runs/live-university-recorder-2026-05-31T10-50-59-804Z`
- Whisper transcripts coherent across all 3 turns; STT finals match expected text within normal variance

**Telephony live smokes (Twilio/Telnyx/SmartPBX):** Blocked by two pre-existing issues:
1. Cartesia TTS `code=1006` (API connectivity) — run with `SYRINX_REVIEW_TTS=gemini` to work around
2. `vadEnd=false` turn timeout — pre-existing G11 VAD speech-end detection bug
   The codec path itself works: `stt=true` (coherent transcript), `agent=true`, `ttsAudio=true`, `carrierOutbound=true`

## WT-05 review fix (reviewer: Opus 4.8) — quick-failure flap guard

Worker impl reset `reconnectAttempt` to 0 on every `open`, so a peer that accepts
the socket then drops it immediately (half-broken server mid-deploy, or a token
accepted-then-rejected) would reconnect forever at attempt-1 delay, never tripping
the storm cap. Added a `minStableMs` (5 s) / `maxQuickFailures` (3) guard mirroring
`@asyncdot/voice-ws`'s `WebSocketConnection`: a socket that opens then dies within
`minStableMs` is a "quick failure"; N consecutive ones give up. A never-opening peer
is left to the existing `maxAttempts` cap; a genuinely stable connection resets the
count. +1 unit test (`gives up after maxQuickFailures open-then-die flaps`). Existing
24 reconnect tests unaffected (their reconnect sockets never dispatch `open`, so the
quick-failure path doesn't engage). Client suite: 32 pass, typecheck clean.

## WT-02 review fixes (reviewer: Opus 4.8)

1. **FIR memoization (hot-path/scale).** `resamplePcm16` rebuilt the 127-tap sinc·Hann
   kernel on every call, though the kernel depends only on the (source,target) cutoff
   — constant per connection. The resampler runs per audio chunk, so this was wasted
   CPU at scale and added enough suite-wide load to tip two latent timing-fragile
   transport tests over. Added a bounded module-level FIR cache keyed by cutoff.
   Spectral lock (87 voice tests) intact.
2. **Determinized a flaky transport test.** `telnyx.test.ts > emits tts.playout_progress
   … after the paced audio drains` waited a fixed 340 ms for a real-time paced drain,
   then asserted `complete:true` — under suite load the drain slipped past the margin
   (~1/3 flake). Replaced with a `waitForCondition` poll on the actual completion event
   (mirrors the existing twilio.test helper). Transport suite now 8/8 green across runs
   (was ~1/3 flaky). The smartpbx "buffers before startup" 5 s-timeout flake also cleared
   once the FIR load was removed.

## VE-04 / G25 — Word-level-timestamp context alignment (closes G2) (2026-05-31)

### Problem the prior G2 revert exposed

The first G2 attempt deadlocked because it tried to do work inside a PipelineBus Main
handler while the bus drain loop was parked awaiting that same handler. G10's concurrent
generation fix eliminated the blocking: the generation handler runs fire-and-forget, so
the drain loop is free during generation and dispatches Critical interrupts promptly.
The current `commitInterruptedHistory` is a pure synchronous map mutation with one
Background push (non-blocking), so there is no deadlock risk.

### Cartesia word timestamps

Cartesia's WebSocket API supports `add_timestamps: true` in the request. Per observed
response format: `{ word_timestamps: { words: [{ word, start, end }] } }` where
`start`/`end` are in seconds and are **per-chunk relative** (start at 0 for each response
message). We add a cumulative per-context audio offset (`contextAudioOffsetMs`) to make
timestamps absolute from the context start. The offset is advanced by each chunk's audio
duration (bytes / 2 / sampleRate × 1000 ms) after emitting the offset-adjusted packet.

### Precision ladder for spoken prefix

1. Word timestamps (`tts.word_timestamps`) + playout position (`tts.playout_progress`)
   → filter words by `endMs ≤ playedOutMs`, join with spaces. Exact at word granularity.
2. Fallback: accumulated text from `tts.text` packets (`spokenByContext`). Approximate —
   may include audio queued but not yet played (TTS streams faster than realtime). Used
   for headless and browser paths that have no paced transport, hence no playout clock.

### What "playout position" is and when it's absent

`tts.playout_progress.playedOutMs` is emitted by the paced playout layer in telephony
transports (telnyx, twilio, smartpbx) as audio actually reaches the wire. For headless
and browser-WS paths there is no paced transport, so no progress packets arrive, and
`playedOutMsByContext` stays empty → fallback path activates.

### Live smoke plan

The spec asks for a live recorder coherence smoke: mid-utterance barge-in, Whisper the
recording, assert assistant audio and logged context end at the same word. This requires
a real Cartesia API key (`SYRINX_REVIEW_TTS=cartesia`), a paced transport (telephony),
and the recorder. The unit tests cover the computational correctness of the spoken-prefix
logic. The live smoke artifact path would be:
`examples/02-hello-voice-headless/test/performance/runs/ve04-word-boundary-<timestamp>/`

Live smoke with a paced transport was blocked: Cartesia API connectivity issues during
the implementation window prevented a Fly telephony run. Unit verification is green.
The live smoke should be re-run when Cartesia API access is confirmed working.

### Tests added

- `voice-bridge-aisdk`: 3 new tests — word-boundary exactness + deadlock regression,
  fallback (no timestamps), fallback (no playout position)
- `voice-tts-cartesia`: 1 new test — word timestamps emitted with correct cumulative offset

## WT-01 — Extract WebSocketTransportHost (collapse 4 transports → 1) (2026-05-31)

### New files

- `packages/voice-server-websocket/src/transport-helpers.ts` — shared utilities: `positiveInteger`,
  `nonNegativeInteger`, `numberFromString`, `optionalPositiveIntegerString`,
  `optionalNonNegativeIntegerString`, `rawDataToText`, `rawDataByteLength`, `cloneRawData`,
  `decodeStrictBase64`, `requireTtsAudioSampleRate`. Previously duplicated 4× across transports.

- `packages/voice-server-websocket/src/transport-host.ts` — `runWebSocketConnection`: the shared
  connection lifecycle. Owns: pending-buffer-until-ready, startup-timeout + abort, heartbeat,
  max-session-duration, backpressured send, close/cleanup. Generic over `TransportAdapter<TState>`.

- `packages/voice-server-websocket/src/outbound-playout-pipeline.ts` — `wireTelephonyOutboundPipeline`:
  the ONE `interrupt.tts` → clear / `tts.audio` → encode+pace / `tts.end` → drain chain.
  Parameterized by carrier callbacks (encodeFrames, onInterrupt, onDrain, onStop, onClear).

### Per-carrier inbound ordering policies (preserved exactly)

| Carrier  | Ordering policy |
|----------|----------------|
| Twilio   | Reject-out-of-order: `rememberTwilioMediaChunk` throws monotonicity violation |
| Telnyx   | Bounded reorder: buffers up to `maxInboundReorderFrames`, flushes on overflow and disconnect |
| SmartPBX | Passthrough: no chunk numbers, frames emitted in arrival order |

### Browser pacing deferred to WT-03

The browser transport inherits `WebSocketTransportHost` for lifecycle but keeps immediate
(non-paced) outbound in WT-01. `wireBrowserSessionEvents` sends TTS chunks directly without
`PacedPlayoutQueue`. WT-03 will wire browser through the outbound pipeline.

### Line counts

| File | Lines |
|------|-------|
| index.ts (browser) | 683 |
| telnyx.ts | 630 |
| twilio.ts | 522 |
| smartpbx.ts | 457 |
| transport-host.ts (new) | 185 |
| outbound-playout-pipeline.ts (new) | 119 |
| transport-helpers.ts (new) | 78 |

Total new transport implementation: 2,674 lines (was 3,397 for four files). No file > 1000 lines.

### Verification artifacts

- `pnpm -r typecheck`: exit 0
- `pnpm --filter @asyncdot/voice-server-websocket test` ×5: 117/117 stable
- `pnpm -r test`: exit 0
- `git diff --check`: clean
- Local emulator smokes (all `qualityGate.passed: true`):
  - Twilio: `test/performance/runs/twilio-emulator-2026-05-31T11-38-47-513Z/`
  - Telnyx: `test/performance/runs/telnyx-emulator-2026-05-31T11-38-51-678Z/`
  - SmartPBX: `test/performance/runs/smartpbx-emulator-g711_ulaw-2026-05-31T11-38-55-747Z/`
- Fly synthetic-carrier smoke: NOT RUN — requires Fly credentials. Run:
  `pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:fly-synthetic-carrier`

## Sprint progress — keys + Wave-1 verification (reviewer: Opus 4.8)

- **API keys:** new Cartesia + ElevenLabs keys saved to `.env` (gitignored, not committed).
  Cartesia 402 (out of credits) earlier blocked live smokes; new key validated below.
- **G27 (voice-ws crash):** found while running VE-04's live smoke — `dispose()` on a still-connecting
  socket crashed the process. Fixed + regression-tested (`b1950ad`). Hardens all provider plugins.
- **VE-04 live debt CLOSED:** recorder-coherence smoke with the new Cartesia key →
  `qualityGate.passed:true`, ttsProvider cartesia, and `tts.word_timestamps` emitted live against the
  real Cartesia API (run `live-university-recorder-2026-05-31T11-43-11-837Z`). Logic was already
  unit-verified (deadlock + word-boundary exactness); the Cartesia live emission is now confirmed too.
- **WT-01 structural verification:** lifecycle skeleton (`withWebSocketStartupTimeout`,
  pending-buffer, heartbeat) now lives ONLY in `transport-host.ts` — zero copies / zero helper
  redeclarations in the 4 carrier files; no source file > 1000 lines; transport suite 117 tests ×5 stable
  (earlier flake fix held). Fly synthetic-carrier (Deepgram TTS) E2E regression running as the final gate.

## WT-04 graceful drain — reviewer completion + root-cause (Opus 4.8)

The wt-04 worker died mid-verification on an external 1M-context **usage-credit limit**
(not a code fault); its implementation was complete in the tree, so I took ownership.

**Implementation (worker, verified correct):** `close({ graceful, drainDeadlineMs })` on the
transport host + per-factory graceful path (drain paced queues → 1001 going-away via
`closeWebSocketWithFallback` → terminate stragglers at the deadline); SIGTERM/SIGINT wired to
graceful close in `serve-telephony-review.ts` + `serve-websocket-review-studio.ts`. 7 unit tests
cover: non-graceful immediate, graceful 1001 (no pending / with pending-audio drain),
force-terminate at `drainDeadlineMs`, browser 1001/1006, multiple clients.

**The flaky 2 browser tests — root cause was the TEST, not the code.** Long debugging arc
(documented so the next dev doesn't repeat it): the 2 browser-server close tests flaked ~50% (100%
in isolation), timing out at 10 s. Marker-instrumentation proved the hang was at
`await readJsonMatching(client, "ready")` — *before* `server.close()` was ever called. Cause: the
browser server sends `ready` **proactively** on connect, but the test attached its `message`
listener only after `await openSocket()` resolved, racing and dropping `ready` (ws doesn't buffer
events without a listener). Telephony tests don't hit this (they send nothing until the client's
`start`). Fix: `openBrowserSocketReady()` attaches the listener before open. Reverted my speculative
`close()` changes (closeServerBounded/boundedAwait/closeAllConnections) — `close()` was never the
problem (the 117-test suite + Fly E2E prove it). graceful-drain.test.ts now 12/12 stable.

**Live smoke:** graceful close is provider-agnostic transport behaviour (socket close codes +
paced-queue drain), fully exercised by the 7 unit tests; SIGTERM wiring verified in the serve
scripts. A real-provider call adds nothing to graceful-CLOSE coverage, so the unit suite is the
proof here (unlike WT-02/VE-04 which touch provider I/O and did need live smokes).

**Known separate issue (pre-existing, NOT WT-04):** `index.test.ts > rejects malformed websocket
JSON text messages before forwarding them` flakes ~20% under suite load (5 s timeout). Untouched by
WT-04; different root cause than the ready-race (its helper attaches the listener before open).
Tracked for a suite-health pass.

## Test-suite flakiness — converged diagnosis (Gemini + GLM) + plan [restored after WT-03 clobber]

Two independent workers (Gemini/agy, GLM/claude-glm) converged: PRIMARY cause = the 4 transport test
files (index/twilio/telnyx/smartpbx.test.ts) have NO `afterEach` cleanup → a failed/timed-out test
leaks real `ws` servers, sockets, heartbeat + PacedPlayoutQueue real-timers that peg CPU and cascade
into later-test timeouts (only graceful-drain.test.ts has proper teardown). Secondary: fixed setTimeout
sleeps vs condition-polls; readers that listen only to `message` (never close/error) hang to timeout;
duplicated helpers w/ divergent timeouts; the 2 unfixed index.test.ts tests racing real bufferedAmount.
PLAN (tracked **WT-10**): (1) afterEach cleanup registry in the 4 files; (2) shared `test-helpers.ts`
(attach-listener-before-open, condition-poll, reject-on-close/error/timeout); (3) fix the 2 tests;
(4) replace high-risk sleeps; (5) vitest config. NO retries (mask regressions), NO fake timers (real ws
I/O). Apply after WT-03 (done). Verify with a 10x suite run before/after.

## WT-03 — browser pacing + playout clock + client jitter buffer (cursor/Sonnet worker `05e92cc`)

Browser adapter now routes outbound TTS through the shared `OutboundPlayoutPipeline` (paced frames +
`PlayoutProgressEmitter` → browser leg gets the G12 playout clock like telephony); new `AudioJitterBuffer`
in `voice-client-browser` schedules decoded PCM on `AudioContext.currentTime + bufferAhead` and flushes on
clear. 41 voice-client-browser tests + new browser-pacing.test.ts. **Reviewer note:** the worker did a
broad `git add` that swept in unrelated files AND overwrote this notes file (−178 lines) — restored from
88ce280. Watch this worker's git hygiene.
