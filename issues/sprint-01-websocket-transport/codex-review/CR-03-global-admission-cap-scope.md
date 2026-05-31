# CR-03 — Admission Cap Was Path-Scoped Only On Shared Servers

- **Status:** Fixed
- **Severity:** high
- **Area:** transport / concurrency / WT-08

## Problem
`maxConcurrentSessions` was enforced against `wsServer.clients.size` for one mounted path only, so a shared HTTP server with multiple transport paths could exceed an intended fleet cap by opening sessions on each path.

## Evidence
- `packages/voice-server-websocket/src/websocket-upgrade.ts:69-77` (before fix): admission compared only one `wsServer.clients.size`.
- Shared-path mount pattern is used in tests and production shape: `packages/voice-server-websocket/src/admission-control.test.ts:112-157`.

## Root Cause
Admission accounting lived inside per-path websocket server instances with no shared counter at the router layer.

## Proposed Solution
Add admission scope selection and shared-server accounting at the upgrade router:
- Add `maxConcurrentSessionsScope?: "path" | "server"`.
- For `server` scope, sum active clients across all routed websocket servers mounted on the same HTTP server.

## Acceptance Criteria
- [x] Admission control supports `path` and `server` scopes.
- [x] Shared-server cap rejects N+1 upgrades across different paths with 1013.
- [x] Existing path-scoped behavior remains default.

## Test Plan
- Added characterization test:
  - `packages/voice-server-websocket/src/admission-control.test.ts:159-203`
  - Verifies Twilio + Telnyx on shared HTTP server enforce one global cap and reject second connection with 1013.

## Definition Of Done
Implemented in:
- `packages/voice-server-websocket/src/transport-host.ts`
- `packages/voice-server-websocket/src/websocket-upgrade.ts`
- `packages/voice-server-websocket/src/{index,twilio,telnyx,smartpbx}.ts`
- `packages/voice-server-websocket/src/admission-control.test.ts`

Verified by full suite and package tests (see final report).
