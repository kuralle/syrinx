# CR-01 — Browser keepalive send race can throw from timer callback

- **Status:** Fixed
- **Severity:** High
- **Area:** client / lifecycle / reliability

## Problem / Evidence

`SyrinxBrowserClient` keepalive checks `transport.connected` then sends `{type:"ping"}` on an interval. If the socket closes between the check and send, `sendJson` can throw from a timer callback.

- `packages/voice-client-browser/src/index.ts:393-397` (keepalive timer send path)
- `packages/voice-client-browser/src/websocket-transport.ts:55-60` (`sendJson` throws when socket is not open)

This creates uncaught timer-path exceptions under close/send races and can destabilize long-lived browser sessions.

## Root cause

Non-atomic `connected` check and send in an async timer context with no exception guard.

## Proposed solution

Catch send failures inside keepalive timer callback, stop keepalive, and emit a client error event.

## Acceptance criteria

- [x] Keepalive send failures no longer escape timer callback as uncaught errors.
- [x] Keepalive stops after a ping send failure.
- [x] Error event is emitted for observability.
- [x] Regression test reproduces race and passes with fix.

## Test plan (TDD + smoke)

- Unit: `packages/voice-client-browser/src/index.test.ts` keepalive case where socket `send()` throws.
- Package test run: `pnpm --filter @asyncdot/voice-client-browser test -- src/index.test.ts`.

## Definition of done

Failing keepalive race test turns green; no uncaught timer error path remains in keepalive.

## Fix notes

- Fixed in working tree:
  - `packages/voice-client-browser/src/index.ts`
  - `packages/voice-client-browser/src/index.test.ts`
