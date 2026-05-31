# WT-08 / G20 — Concurrency cap + admission control + upgrade-path leak

- **Status:** Blocked (WT-01) · **Priority:** P2 · **Phase:** 2 (scale)
- **Area:** transport / scale · **Findings:** F9 (concurrency), F10 (socket leak)
- **Depends on:** WT-01 · **Blocks:** —
- **Catalog:** G20

## Problem / Evidence

- **F9 — no concurrency cap.** The `sessions` Set/Map grows unbounded; nothing
  rejects the N+1th connection. Deepgram guide (line 766): *"WebSocket concurrency
  limits"* + backpressure during traffic spikes. Unbounded acceptance → OOM /
  provider rate-limit storms under load.
- **F10 — unmatched upgrade leaks sockets.** `websocket-upgrade.ts:17` `onUpgrade`
  only handles its own path; an upgrade to an unregistered path matches no
  listener that destroys the socket → the TCP socket dangles until OS timeout. A
  scanner hitting random `ws://` paths leaks FDs.

## Root cause (diagnose)

Admission was never modeled (review-scale only); the routed-upgrade helper assumes
every upgrade matches some registered path.

## Proposed solution (rfc)

1. **Admission control in `WebSocketTransportHost`:** `maxConcurrentSessions`
   option; on the N+1th upgrade, reject cleanly (close `1013` "try again later" /
   HTTP 503 on the upgrade) and emit a `transport.admission_rejected` metric.
   Optionally a per-`createSession` provider-capacity check hook.
2. **Upgrade-path fallback:** a single shared upgrade router (or a terminal
   listener) that, when **no** registered path matches, `socket.destroy()`s the
   connection instead of leaking it. Keep the existing multi-path mounting working.

## Acceptance criteria
- [ ] `maxConcurrentSessions` rejects beyond the cap with a clean close + metric.
- [ ] Unmatched upgrade paths are destroyed, not leaked (no dangling sockets).
- [ ] Multi-carrier mounting on one HTTP server still routes correctly (regression).

## Test plan (TDD + smoke)
- **Unit:** open `cap` sessions then assert the next is rejected with 1013 + metric;
  upgrade to an unknown path → socket destroyed (assert `close`/`destroy` called),
  registered paths still connect; the existing same-server multi-adapter routing
  test stays green.
- **Smoke (live):** drive the public-TLS probe against an unknown path and assert
  the socket is closed promptly (no hang).

## Definition of done
Bounded concurrency with clean rejection + metric, no socket leak on bad paths,
multi-adapter routing intact.

## Sources
Deepgram guide (concurrency limits, draining); review F9, F10.
