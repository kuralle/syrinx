# RFC: WS transport correctness hardening (Wave 1)

> **Status:** Ready-for-build · **Branch:** `v2` · **Owner:** manager (octalpixel) · **Date:** 2026-06-06
> **Source plan:** [`../bi-model-research/transport-hardening-plan.md`](../bi-model-research/transport-hardening-plan.md)
> (staff-architect-reviewed, codex high → revised). This RFC executes **Wave 1 only**: the *evidenced,
> no-product-decision* correctness fixes. Out of scope (later waves, each needs a decision/spike): inbound
> auth scheme (R-04), route-A inbound unification (needs the spike), WebRTC (needs topology DR R-07).

Section 5 (WBS) is the delegation plan — each chunk is a literal `/delegate --to cursor` contract.

---

## 1. Problem (problem-first)

Two correctness problems in the transport layer, both verified in code, both invisible until production load:

**P1 — a reconnect attempt can wedge forever.** `WebSocketConnection.openSocket` (`packages/ws/src/index.ts:223`)
does `const socket = await this.opts.socketFactory(...)` (`:228`) then returns a `new Promise` that settles
only on `onOpen`/`onError`/`onClose` (`:252-290`). **Nothing bounds either step.** If the factory hangs
(a Workers `fetch`-upgrade that never resolves) or the socket sits in CONNECTING and never fires an event,
`await openSocket()` inside `tryReconnect` (`:304`) never returns — the reconnect loop is dead, silently.
The only timeout in the file, `ensureReady`'s `connectTimeoutMs` (`:179-180`), gates the *caller waiting for
ready*, not the attempt itself. **And** even when a socket "opens", `verify()` on the built-in WebSocket
(web/workers) is a `readyState===OPEN` check (`web-socket.ts:49`, `workers.ts:108`) — a half-open Workers
socket reads OPEN and is trusted on a dead link. A link that flaps just above `minStableMs` resets
`quickFailures` (`index.ts:322`) and reconnects forever with no give-up.

**P2 — `response.create` can race an active response (plausible, unproven).** Both realtime adapters track
`activeResponse` and guard `cancelResponse` (`from-openai-realtime.ts:158`, `from-grok-realtime.ts:147`),
but `injectToolResult` sends `response.create` with **no `activeResponse` check**
(`from-openai-realtime.ts:173-185`, `from-grok-realtime.ts:152-162`). In the bi-model flow (front emits a
tool call mid-response → bridge runs the Reasoner → `injectToolResult`), a `response.create` can be sent
while the provider still considers a response active → "conversation already has an active response". This is
**not yet reproduced** — Wave 1 proves it (or disproves it) before choosing a fix.

## 2. Ideal end-state (invert the bad ideas — frame the ideal, then work backwards)

Don't patch symptoms; state what a correct transport *is*, then derive the minimal change to today's code.

- **Ideal A — bounded, honest connectivity.** *Every* connection attempt is strictly time-bounded; a link is
  trusted only after a *real* liveness signal, not a status enum; a chronically-failing link gives up with a
  surfaced error instead of looping. → Working backwards into `WebSocketConnection`:
  1. wrap **both** the `socketFactory` await and the open-promise in a single `connectTimeoutMs` deadline that
     disposes the socket and rejects → `tryReconnect`'s backoff proceeds instead of hanging.
  2. make `verify()` an **app-level round-trip** where no frame-ping exists (web/workers), falling back to
     `readyState` only if no probe is configured.
  3. add a **max-total-reconnect-duration breaker** so flapping eventually rejects to `onUnrecoverable`.

- **Ideal B — a serialized response lifecycle you can prove.** The system *never* sends `response.create`
  while a response is active, and there is a test that would fail if it did. → Working backwards: first write
  the **failing interleaving test** (cancel-in-flight → tool-result → create). If it reproduces, the minimal
  correct fix is to **gate `response.create` on `!activeResponse`** (and queue a single pending create to fire
  on the next `response.done`/cancelled) — a focused serializer, *not* a port of the whole SDK sequencer
  unless the gate proves insufficient. If it does **not** reproduce, document why (our cancel ordering already
  serializes) and close it — no speculative machinery.

## 3. Goals / non-goals
**Goals:** G1 no reconnect attempt can hang unbounded; G2 liveness is a real signal on every runtime; G3
flapping links give up; G4 the response-create race is reproduced-or-disproved and, if real, minimally fixed,
for **both** OpenAI and Grok adapters. **Latency-neutral** (gate §4).
**Non-goals:** inbound auth, route-A inbound unification, WebRTC/SIP, the richer event model (responseId/usage/
typed-errors), mute, base64/crypto consolidation — all later waves. No new deps. No kernel edits.

## 4. Latency-gate methodology (supersedes "~0ms")
These are reconnect/lifecycle paths, off the steady-state hot path — but verify no steady-state regression:
run the short-fixture live smoke (`SYRINX_WS_MAX_TURNS=1`), N≥10, compare P50/P95 of LLM-TTFT + first-audio
vs the pre-change baseline; pass = no P95 regression. Unit-level: the new timers must not add latency on the
happy path (deadline cleared on open).

## 5. Work breakdown (delegation plan — cursor)
Two chunks, **file-disjoint** (`packages/ws` vs `packages/realtime`+`packages/grok`) → run in parallel.
Manager reviews each git diff + runs tests/gates before merge-accept.

### Chunk A — `packages/ws` reconnect hardening (G1–G3)
- **Scope:** `packages/ws/src/index.ts` (openSocket/tryReconnect/options), `web-socket.ts`, `workers.ts`,
  `node.ts` (verify wiring), + `index.test.ts`/`web-socket.test.ts`.
- **Implement (backwards from Ideal A):**
  - **A1 handshake deadline:** in `openSocket` (`index.ts:223-292`) bound the whole attempt (factory await
    `:228` + the open promise `:231`) with `connectTimeoutMs`; on deadline dispose the socket + reject so
    `tryReconnect` backs off. Clear the deadline on first settle. Don't change happy-path behavior.
  - **A2 real liveness probe:** add an optional `livenessProbe?: (socket) => Promise<boolean>` /
    app-ping option; `WebSocketConnection.verify()` uses the frame-ping on Node (`node.ts`) and the app
    probe on web/workers; only if neither exists, fall back to the current `readyState` check.
  - **A3 circuit breaker:** add `maxReconnectDurationMs?`; track first-disconnect-of-a-burst so a link
    flapping just above `minStableMs` (`:322`) eventually rejects to `onUnrecoverable` instead of forever.
- **DoD/acceptance (tests):** (a) factory that never resolves → `openSocket` rejects within
  `connectTimeoutMs`; (b) socket that fires no event after construct → same; (c) web/workers socket reporting
  OPEN but whose app-probe reply never arrives → `verify()` resolves `false` → reconnect continues; (d)
  socket alive `minStableMs+1` each cycle → gives up after `maxReconnectDurationMs`. Node frame-ping path
  unchanged. `pnpm -r typecheck` + `pnpm --filter @kuralle-syrinx/ws test` green; existing tests green.
- **Out of scope:** the realtime adapters, base64/crypto, event model.

### Chunk B — realtime response-sequencing: repro then minimal fix (G4)
- **Scope:** `packages/realtime/src/from-openai-realtime.ts` + test, `packages/realtime/src/realtime-bridge.ts`
  if needed, `packages/grok/src/from-grok-realtime.ts` + test. Read `realtime-bridge.ts` `runDelegate`.
- **Implement (backwards from Ideal B):**
  - **B1 repro FIRST:** a unit test with a mocked socket driving the exact interleaving — `response.created`
    (activeResponse=true) → `cancelResponse` (response.cancel sent, but no `response.done` yet) →
    `injectToolResult` (function_call_output + response.create) — and assert what the adapter sends. Make the
    test express the *invariant* "never send `response.create` while `activeResponse`". Do this for OpenAI AND
    Grok (Grok: blocking tools + no-truncate path).
  - **B2 minimal fix IF the invariant is violated:** gate `response.create` in `injectToolResult` on
    `!activeResponse`; if a create is requested while active, record a single pending-create and fire it on the
    next `response.done`/cancelled. Do NOT port the full SDK sequencer unless the gate is provably
    insufficient (justify in the proof if so).
  - **B3 if NOT reproduced:** leave behavior unchanged, keep the test as a regression guard, and write one
    paragraph in the proof explaining why our ordering already serializes.
- **DoD/acceptance:** the repro test exists and is green (either proving the gate works, or proving no
  violation); both adapters covered; `pnpm -r typecheck` + `pnpm --filter @kuralle-syrinx/realtime test` +
  `pnpm --filter @kuralle-syrinx/grok test` green. No `as any`. Edge-clean preserved.
- **Out of scope:** the full ResponseCreateSequencer port (only if B2's gate is insufficient — flag, don't build speculatively).

## 6. Verification ladder (done = all)
`pnpm -r typecheck` + all three package suites green; Chunk A's four reconnect tests + Chunk B's repro test
green; the live short-fixture latency gate shows no P95 regression; manager notes written.

## 7. Risks
- A1's deadline must not fire on a slow-but-valid open → make `connectTimeoutMs` the single source and clear
  it on settle. - B2's pending-create queue must not drop a legitimate create → cover with the test.
- These touch the reconnect core used by every provider socket — run the full `ws` + provider suites, not just new tests.
