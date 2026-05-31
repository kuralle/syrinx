# WT-04 / G16 — Graceful connection draining on shutdown

- **Status:** Blocked (WT-01) · **Priority:** P1 · **Phase:** 1
- **Area:** transport / scale · **Findings:** F5
- **Depends on:** WT-01 · **Blocks:** —
- **Catalog:** G16

## Problem / Evidence

Every server's `close()` hard-kills all calls:
- `index.ts:172`, `twilio.ts:171`, `telnyx.ts:194`, `smartpbx.ts:168`:
  `for (const client of wsServer.clients) client.terminate();`

`terminate()` is an immediate TCP kill — no close frame, no playout drain, no
recorder flush coordination. **Every deploy or scale-in drops every in-flight
call mid-sentence.** The correct primitive already exists and is used elsewhere:
`websocket-close.ts` `closeWebSocketWithFallback` (close → 250 ms grace →
terminate). Deepgram guide (line 768): *"Implement graceful connection draining
and backpressure during traffic spikes."*

## Root cause (diagnose)

`close()` was written for test teardown (fast, hard) and never differentiated
from production shutdown.

## Proposed solution (rfc)

Add graceful drain to `WebSocketTransportHost` (built in WT-01):
- `close({ graceful, drainDeadlineMs })`. On graceful close: stop accepting new
  upgrades, let each connection's paced queue drain to a deadline (default e.g.
  10 s), send a transport `close` (1001 "going away") via
  `closeWebSocketWithFallback`, flush recorders, **then** terminate stragglers
  past the deadline.
- Wire SIGTERM/SIGINT in the serve entrypoints (`serve-telephony-review.ts`,
  `serve-synthetic-carrier.ts`, browser studio) to call graceful close.
- Keep a fast `close({ graceful:false })` for tests.

## Acceptance criteria
- [ ] Graceful close drains paced audio + sends 1001 + flushes recorder before terminate.
- [ ] Stragglers past `drainDeadlineMs` are terminated (no hang).
- [ ] SIGTERM triggers graceful close in the serve entrypoints.
- [ ] Test teardown path stays fast (non-graceful) so the suite doesn't slow.

## Test plan (TDD + smoke)
- **Unit:** with a pending paced queue, graceful close drains it and emits 1001;
  a wedged consumer is force-terminated at the deadline; non-graceful close is
  immediate.
- **Smoke (live):** during a live telephony adapter smoke, trigger graceful close
  mid-utterance; assert the recorder manifest shows a clean (non-truncated-at-zero)
  finalize and the client received a 1001, not an abrupt RST.

## Definition of done
Deploys no longer guillotine live calls; graceful drain proven in unit + live
smoke; SIGTERM wired.

## Sources
Deepgram guide (graceful draining); existing `closeWebSocketWithFallback`; F5.
