# stt-core migration — Wave 2 (Nova) implementation notes

Slug: `stt-core-migrate-w2-nova`

## Goal

Migrate `DeepgramSTTPlugin` (nova) onto `@kuralle-syrinx/stt-core` behavior-preserving, by adding optional async-emit / finalize-lifecycle seams and porting the Finalize state machine into `DeepgramSttWireProtocol`.

## Assumptions

- Optional base seams only; Wave-1 providers (grok/elevenlabs/google/flux) unchanged.
- Nova finalize/timeout/gating/dedupe ported VERBATIM — move + re-wire, not redesign.
- Billing moves to the base byte-delta funnel (`format` passed into the session).
- Live smokes are manager-owned.

## Seams added (stt-core)

| Seam | Purpose |
|------|---------|
| `SttEvent.turn_complete` | Eos-only commit after per-segment `final`s (no result/usage) |
| `SttProtocolHost` + `attach?` | Timer-driven `emit` / `reset` through the engine funnel |
| `onFinalizeSent?` | Start Finalize timeout after encodeFinalize frames are sent |
| `Transport.reset?` | Session wires `conn.reset()` for consecutive-timeout reconnect |

## Nova shape after migration

- `DeepgramSttWireProtocol` owns: multi-segment accumulation, speech_final/from_finalize gating, ignoreNext, retired-context set, Finalize timeout/fallback/reset, UtteranceEnd backstop, SpeechStarted, provider metrics, CloseStream/Finalize frames.
- `DeepgramSTTPlugin` is thin: config → `startStreamingSttSession`, `reconfigure` → mutate + `session.reset()`, `forceFinalize` → bus `stt.finalize`.
- Context id for protocol bookkeeping: plugin tracks `currentContextId` from `stt.audio` / `turn.change` (registered before session so `encodeAudio` metrics see the live turn).

## Accepted deviations

1. **Private `plugin.conn` poke removed** from one test. The old test replaced the internal WebSocketConnection; after migration the conn lives in the session. Replaced with a behavioral test (finalize with no audio → metrics bytes:0, no usage). Same intent, no private surface.
2. **Audio-stats metrics vs billing:** metrics bytes are recorded in `encodeAudio` (send path); billing is the base's post-send `sentBytes` funnel. Successful-path amounts match pre-migration. A mid-send throw could theoretically record metric bytes the base does not bill — same class of edge as Wave-1 accepted validation coupling.
3. **`forceFinalize` is fire-and-forget via bus → async `engine.onFinalize`** (awaits `ensureReady`). Original was sync for the send+timer half. Existing tests use short waits; all green.
4. **`streamStartTime` dropped** — write-only dead field pre-migration.

## Verification

- `pnpm -r typecheck` = 0
- `pnpm --filter @kuralle-syrinx/stt-core test` — 20 passed
- `pnpm --filter @kuralle-syrinx/deepgram test` — 54 passed (incl. new ignoreNext + empty-discard paths)
- Wave-1 packages not edited
