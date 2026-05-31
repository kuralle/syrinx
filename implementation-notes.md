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
