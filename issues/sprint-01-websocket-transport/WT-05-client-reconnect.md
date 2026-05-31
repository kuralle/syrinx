# WT-05 / G17 — Browser client reconnect + resume + keepalive

- **Status:** Ready · **Priority:** P1 · **Phase:** 1
- **Area:** client / availability · **Findings:** F6
- **Depends on:** — (server resume window already exists) · **Blocks:** WT-07
- **Catalog:** G17

## Problem / Evidence

The shipped client cannot use the resume feature the server already built:
- `voice-client-browser/src/index.ts:100` `connect()` opens a socket and on
  `close` (`:112`) just emits an event — **no auto-reconnect**, no `sessionId`
  capture from the `ready` message, no `?sessionId=` resume dial, **no client
  keepalive ping** (the protocol defines a `ping` type the client never sends).
- The server has a 15 s `sessionId`-keyed resume window
  (`voice-server-websocket/src/index.ts:392` `getOrCreateManagedSession`,
  `:436` `scheduleManagedSessionClose`) that retains turn/sample-rate/sequence
  state — but nothing on the client exercises it.

The corpus's #1 mitigation (reconnect-and-resume) is half-built. Kwindla §4.6.1:
*"WebSocket reconnection logic is quite hard to implement robustly. You will have
to build a ping/ack framework."* Deepgram (line 592): reconnect with backoff and
restore prior context rather than leaving silence.

## Root cause (diagnose)

`SyrinxBrowserClient` was written as a thin send/receive wrapper; resilience was
deferred to "the app." But resume only works if the client re-dials with the
retained `sessionId`, which no app can do because the client never surfaces it.

## Proposed solution (rfc)

Harden `SyrinxBrowserClient`:
- Capture `sessionId` from the `ready` message; expose it.
- On unexpected `close` (not a clean app-initiated close), **reconnect with
  exponential backoff + jitter**, re-dialing `${url}?sessionId=${sessionId}` so
  the server resumes the retained session within its window.
- Send a periodic client **keepalive** (`{type:"ping"}`) tuned below the smallest
  expected idle timeout, to defend against proxies/LBs that silently kill idle
  sockets.
- Emit explicit `reconnecting` / `reconnected` / `resumed` events so the UI can
  show state instead of going dead.
- Reconnection storm guard: cap attempts, back off, stop after N to avoid
  hammering during a server outage/deploy.

## Acceptance criteria
- [x] Client captures + exposes `sessionId`; reconnects with backoff on unexpected close.
- [x] Reconnect re-dials `?sessionId=` and the server resumes the same session
      (turn/sample-rate/sequence preserved) within the window.
- [x] Periodic keepalive ping sent; configurable interval.
- [x] `reconnecting`/`reconnected`/`resumed` events emitted; storm-capped.

## Test plan (TDD + smoke)
- **Unit:** fake socket: unexpected close → backoff schedule + re-dial URL carries
  `sessionId`; clean close → no reconnect; keepalive fires on interval; storm cap
  stops after N.
- **Smoke (live):** headless-Chrome smoke that drops the socket mid-session and
  asserts the client reconnects, the server reports `resumed:true`, and audio/turn
  state continues without a fresh session; capture the artifact.

## Definition of done
Client reconnects + resumes + keepalives against the real server resume window;
proven in unit + headless-Chrome live smoke.

## Sources
Kwindla §4.6.1 (reconnection); Deepgram (line 592); Level-Up (state-on-the-socket); F6.
