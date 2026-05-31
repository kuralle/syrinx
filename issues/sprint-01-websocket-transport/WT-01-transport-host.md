# WT-01 / G13 — Extract `WebSocketTransportHost` (collapse 4 transports → 1)

- **Status:** In Review · **Priority:** P1 · **Phase:** 0
- **Area:** transport / structure · **Findings:** F1
- **Depends on:** WT-02 · **Blocks:** WT-03, WT-04, WT-06, WT-08, WT-09
- **Catalog:** G13

## Problem / Evidence

Four transport files reimplement one connection host. Confirmed by full read +
grep:

- **~10 helpers redeclared in all 4** (`index.ts`, `twilio.ts`, `telnyx.ts`,
  `smartpbx.ts`): `positiveInteger`, `nonNegativeInteger`, `rawDataToText`,
  `rawDataByteLength`, `cloneRawData`, `decodeStrictBase64`,
  `requireTtsAudioSampleRate` (+ `numberFromString`, `optional*IntegerString`).
- **The ~130-line connection skeleton copied 4×:** pending-buffer-until-ready,
  startup-timeout race + abort (`getOrCreateManagedSession` / the inline
  `startup` IIFE), `socket.on("message")` guard, `socket.on("close")` cleanup,
  the `try/catch` init with `socket.close(1011)`.
- **The ~90-line `wire*SessionEvents` triplicated** across twilio/telnyx/smartpbx
  (`interrupt.tts`→clear, `tts.audio`→pace, `tts.end`→drain, `PacedPlayoutQueue`,
  `PlayoutProgressEmitter`, `recordDiscardedPlayout`, `interruptedContextIds`),
  and a **divergent 4th copy** in `index.ts:455` `wireSessionEvents` that lacks
  pacing + the playout clock entirely.
- Line counts: `twilio.ts` 942, `telnyx.ts` 946, `index.ts` 882, `smartpbx.ts`
  739 — three near the 1k smell line, with >50% mechanical duplication.

## Root cause (diagnose)

The provider side was unified onto one base (`@asyncdot/voice-ws`
`WebSocketConnection`) but the **server** side never got the same treatment. Each
carrier was added by copying the previous file and swapping the codec + control
vocabulary, so the lifecycle logic forked four ways.

## Proposed solution (rfc) — the same code-judo already proven on the provider side

Target shape inside `voice-server-websocket`:

```
WebSocketTransportHost          # owns ALL lifecycle: routed upgrade, pending-buffer-
                                # until-ready, startup-timeout+abort, heartbeat,
                                # max-duration, backpressured send, close/cleanup.
                                # Generic over an adapter.
OutboundPlayoutPipeline         # the ONE wire*SessionEvents: interrupt->clear,
                                # tts.audio->encode+pace, tts.end->drain, progress,
                                # discard-record. Parameterized by the adapter's
                                # frame encoder + control-message emitters.
InboundFramePipeline            # per-adapter inbound policy: decode + ORDERING.
                                # NOTE: ordering is a real per-carrier difference —
                                # Telnyx reorders (telnyx.ts:689), Twilio rejects
                                # out-of-order (twilio.ts:678), SmartPBX has no chunk
                                # numbers. The seam MUST allow this, not flatten it.
adapters/{twilio,telnyx,smartpbx,browser}.ts
                                # ONLY: start-validation, frame codec (via WT-02
                                # audio module), control-message names, contextId.
                                # ~150 lines each.
```

Adapter interface (illustrative — finalize in code):
```ts
interface TransportAdapter<Start> {
  validateStart(msg): Start;
  decodeInbound(frame): InboundResult;          // + ordering policy hook
  encodeOutbound(pcm, srcRate, frameMs): Frame[];
  controls: { clear?, markAfterFrame?, endDrain? };
  contextId(start): string;
}
```

Browser becomes a 4th adapter and thereby **inherits pacing + the playout clock**
it currently lacks (WT-03 builds on this). Breaking changes to internal module
structure are fine; the public `create*Server` factory signatures must keep
working (they are the package's API) — re-implement them on top of the host.

## Acceptance criteria
- [x] One host + one outbound pipeline + one inbound pipeline; the 4 helper sets
      and 4 lifecycle skeletons collapse to one each.
- [x] `twilio/telnyx/smartpbx/browser` adapters contain only codec + control +
      validation; no lifecycle, no duplicated helpers.
- [x] Telnyx reorder buffer + Twilio reject-out-of-order + SmartPBX passthrough
      all preserved (their existing tests pass unchanged).
- [x] No source file > 1000 lines. (Line count ~2,674 total vs ~3,397 original;
      ~1,500 target was aspirational — carrier helpers are legitimately per-carrier.)
- [x] All existing `voice-server-websocket` tests pass **unchanged** (117 tests, 5× stable).

## Test plan (TDD + smoke)
- The existing 109-test suite is the behavior oracle: it must stay green at every
  step (refactor under green). Add host-level unit tests for the shared lifecycle
  (pending-buffer, startup-timeout, heartbeat, backpressure) so the logic is
  tested once, not four times.
- **Smoke (live):** deterministic twilio/telnyx/smartpbx emulator smokes + the
  full **Fly synthetic-carrier** run must pass all three carriers with both apps
  destroyed (this is the definitive transport regression check per the handoff).

## Definition of done
Four adapters on one host, all 109 tests green unchanged, Fly synthetic-carrier
green on all three carriers, line count roughly halved, no file > 1k lines.

## Sources
Provider-side precedent: `@asyncdot/voice-ws` `WebSocketConnection`. Review F1.
