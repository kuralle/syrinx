# WT-06 / G18 — Externalizable `SessionStore` interface

- **Status:** Blocked (WT-01) · **Priority:** P2 · **Phase:** 2 (scale seam)
- **Area:** transport / scale · **Findings:** F7
- **Depends on:** WT-01 · **Blocks:** —
- **Catalog:** G18

## Problem / Evidence

Session/resume state is a bare in-process `Map`:
- `voice-server-websocket/src/index.ts:122` `const sessions = new Map<string, ManagedSession>()`.

It dies with the process/redeploy and cannot be shared across instances, so
horizontal scaling forces sticky-session routing and resume breaks on instance
loss. Level-Up article: *"It's not audio quality. It's not latency. It's state."*
and *"make the Redis migration a one-line config change, not an architectural
rewrite."* Cloudflare's design binds state to an addressable Durable Object.

## Root cause (diagnose)

Resume was built for single-instance review; the store was never abstracted.

## Proposed solution (rfc) — install the seam now, ship in-memory as default

Define a `SessionStore` interface and route all resume logic through it:
```ts
interface SessionStore {
  lease(sessionId): Promise<ManagedSessionLease>;   // get-or-create + mark active
  release(sessionId, retainMs): Promise<void>;       // schedule close after window
  get(sessionId): Promise<ManagedSession | null>;
}
```
- Ship `InMemorySessionStore` (today's behavior) as the default — **zero behavior
  change** for current deployments.
- Make the store injectable via `VoiceWebSocketServerOptions.sessionStore`.
- This is an interface installation, **not** a Redis build — but it must be shaped
  so a `RedisSessionStore` / DO-backed impl is a drop-in (no transport rewrite).
  Note in `implementation-notes.md` the at-most-one-active-connection invariant a
  distributed impl must enforce (the `connectionCount` guard).

> This is a seam, not a deferral: the interface + in-memory impl + injection point
> ALL ship in this issue. The distributed impl is a future *configuration*, not
> future *architecture*.

## Acceptance criteria
- [ ] `SessionStore` interface + `InMemorySessionStore` default; behavior identical to today.
- [ ] All `sessions` Map access in the host goes through the store.
- [ ] Store is injectable; a test fake proves the seam (e.g. an instrumented store
      observing lease/release).
- [ ] Existing resume-window tests pass unchanged.

## Test plan (TDD + smoke)
- **Unit:** in-memory store lease/release/get; resume within window returns same
  session; past window creates fresh; injected fake store receives the expected
  lease/release calls in order.
- **Smoke (live):** existing browser resume smoke (with WT-05) still passes through
  the store abstraction.

## Definition of done
Resume runs through an injectable `SessionStore`; in-memory default unchanged;
seam proven by an injected fake; distributed-impl invariants documented.

## Sources
Level-Up (state externalization); Cloudflare (Durable Object state); F7.
