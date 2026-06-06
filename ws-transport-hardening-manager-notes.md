# WS transport hardening (Wave 1) — manager notes

Goal: execute the evidenced, no-decision correctness fixes from `bi-model-research/transport-hardening-plan.md`
(staff-architect reviewed). Plan/RFC: `docs/rfc-ws-transport-hardening.md` (problem-first, ideal→backwards).
Worker: cursor. Manager reviewed each diff + ran suites + a live regression.

## Chunks
| Chunk | Scope | Status | Gate |
|---|---|---|---|
| A — ws reconnect hardening | `packages/ws` | ✅ done | 18/18 ws tests; typecheck 0 |
| B — response-sequencing repro+fix | `packages/realtime`+`packages/grok` | ✅ done | 24+11 tests; live bi-model regression `ok:true` |

## A — what shipped (A1/A2/A3)
- **A1 handshake deadline:** `openSocket` now arms a `connectTimeoutMs` deadline at the top of the executor
  (`index.ts:257`) BEFORE the factory call (which runs in an async IIFE, `:285-287`) → both a hanging
  `socketFactory` and a stuck-CONNECTING socket are bounded; a late-resolving factory disposes its socket
  (`:288-291`); deadline cleared on settle; stale-socket guard preserved (`bindSocket`).
- **A2 real liveness probe:** optional `livenessProbe?(socket)=>Promise<boolean>` on options; `verify()` uses
  Node frame-ping → app probe (with timeout race) → `readyState` fallback.
- **A3 circuit breaker:** `maxReconnectDurationMs` — flapping links give up to `onUnrecoverable`.
- Manager: removed cursor debris (`ws-hardening-implementation-notes.md`). Reviewed the A1 factory-await
  bounding personally (the subtle part) — correct.

## B — what shipped (repro-first, minimal)
- **race_reproduced: true** — cursor PROVED it before fixing (per brief): (1) direct inject while active, and
  (2) cancel-in-flight (old `cancelResponse` cleared `activeResponse` optimistically, so inject sent
  `response.create` while the provider response was still server-side-active).
- **Minimal fix (no speculative sequencer):** `pendingResponseCreate` gate — `injectToolResult` only sends
  `response.create` when `!activeResponse`, else stores ONE pending create flushed by `completeResponse()` on
  `response.done`; and `cancelResponse` no longer clears `activeResponse` optimistically (defers to done).
  Applied to BOTH OpenAI + Grok adapters. No sequencer file built (correctly avoided over-engineering).
- Normal bi-model path unchanged (tool_call arrives after `response.done` clears activeResponse) — verified
  live (`smoke:realtime-university` `ok:true`).
- Manager: removed cursor debris (`realtime-sequencing-implementation-notes.md`).

## Verification
- `pnpm -r typecheck` = 0 errors. realtime 24/24, grok 11/11, ws 18/18. Live bi-model regression green.

## Out of scope (later waves — each needs a decision/spike, per the reviewed plan)
- Inbound auth (R-04) — needs an auth-scheme decision; P0 IFF the `/ws` edge is reachable by untrusted clients.
- Route A (unify inbound hosts on one `ManagedSocket` TransportLayer) — needs the de-risking spike first.
- WebRTC (route B) — needs the topology DR (R-07, owner decision).
- P1 event-model enrichment (responseId/usage/typed-errors), mute, base64/crypto consolidation.

## State
Not committed (awaiting user "commit and push" as in prior waves). RFC + this note + the diffs are ready.
