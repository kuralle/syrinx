# Transport hardening + new-transports plan

> Outcome of the `transports-harden-study` workflow (5 agents, 2026-06-06): deep-read openai-agents-js
> (`agents-realtime`, `agents-extensions`, `agents-openai`) + openai-agents-python transport source, mapped
> vs our seam, synthesized a plan. We **borrow patterns, not the SDK** (per `transport-decision.md`).
> Source clones (gitignored): `bi-model-research/openai-agents-{js,python}/`.

## Confirmed real bugs/gaps in OUR code (verified against source)
1. **`openSocket` handshake has no deadline** — `packages/ws/src/index.ts:231` `new Promise` can hang forever
   if a socket stalls in CONNECTING (never open/error/close); `connectTimeoutMs` only gates `ensureReady`, not
   the factory open → a wedged reconnect attempt.
2. **`verify()` is a `readyState===OPEN` no-op on Workers/web** (`web-socket.ts:49`, `workers.ts:108`) — a
   half-open Workers socket reads OPEN and "passes" verification on a dead link.
3. **No `ResponseCreateSequencer` (plausible, UNPROVEN — review R-02)** — we mint our own `contextId`
   decoupled from provider response ids (`realtime-bridge.ts:233-247`), and `injectToolResult` sends
   `response.create` without checking `activeResponse`. Under the bi-model flow (front delegates mid-turn +
   barge-in) this *could* cause "conversation already has an active response" errors — but it is not yet
   reproduced; gate on the repro before treating it as a confirmed bug. Theirs: `responseCreateSequencer.ts`
   / `openai_realtime.py:197-363`.
4. **base64 triplicated + two divergent decoders** (`from-openai-realtime.ts:387-400`, `grok/src/base64.ts`,
   `edge.ts:497-502`, and a `Buffer.from` variant in `transport-helpers.ts:64-72`). Bare `crypto.randomUUID`
   in the scoped packages is **2 sites** (`realtime-bridge.ts:235`, `cartesia/src/index.ts:121`) — corrected
   from an earlier "5+" overstatement (review R-03); `edge.ts`/`worker.ts` already use a guarded helper.
5. **Two inbound hosts duplicate the same 5 concerns** — `transport-host.ts` (`TransportAdapter<TState>`,
   `ws`-typed) vs `edge.ts` (monolith, `ManagedSocket`-bound): startup-timeout/max-session/max-inbound/
   keepalive/idle implemented twice.
6. Event model too thin: `RealtimeEvent` `response_started/done` carry **no payload** (no responseId/usage/
   finish reason); `transcript` has no item id/timing; `error.recoverable` is a coarse boolean.

## Patterns worth stealing (ranked, tied to their file:line)
1. **ResponseCreateSequencer** (`responseCreateSequencer.ts`) — serialize response.create vs in-flight +
   cancel races, coalesce auto-requests, invalidate waiters on disconnect. **Highest leverage** (invisible
   until load). Port provider-neutral into `packages/realtime`.
2. **Per-runtime shim selected by `exports` conditions** (`agents-realtime/_shims/shims-{node,workerd,browser}.ts`)
   — only 3 symbols (`WebSocket`, `isBrowserEnvironment`, `useWebSocketProtocols`); runtime branching lives in
   the shim, transport reads a symbol. We do this for sockets (`SocketFactory`) but base64/crypto are ad-hoc →
   collapse into one `core/runtime` helper.
3. **Richer transport events** — audio carries `responseId` (`transportLayerEvents.ts:33`), typed
   `turn_started/done`, `usage_update`, transcript `{itemId,delta,responseId}`. Add `responseId` + `usage` +
   typed error category to our `RealtimeEvent` (usage feeds latency telemetry — our #1 priority).
4. **`mute()/muted:boolean|null`** (`transportLayer.ts:66,126`) — first-class input gating; "null = unsupported"
   honesty. We only have `sendAudio`; bridge forwards unconditionally.
5. **Ephemeral-token auth** — `ApiKey = string | (()=>string|Promise<string>)` awaited at connect
   (`openaiRealtimeBase.ts:209`); browser rejects raw keys unless `ek_`; auth via subprotocol on workerd/browser
   (can't set WS headers) vs Authorization header on Node (`openaiRealtimeWebsocket.ts:211-224`). Make our
   `headers` a thunk so reconnects re-mint.
6. **Reconnect discipline** — pong-deadline `terminate()` (`responsesWebSocketConnection.ts:483-503`),
   `withTimeout/withAbortSignal`; Python `handshake_timeout`. We lack handshake deadline + circuit breaker.

## WS hardening backlog (latency gate: see §"Latency-gate methodology" below — not "~0ms")
**P0 (concrete, evidenced bugs — ship independently)** — P0-1 handshake deadline in `openSocket`; P0-3 real
liveness probe (app round-trip) replacing the no-op `verify()`. These are demonstrable hangs and should land first.
**P0-candidate, GATED on a repro (review R-01/R-02)** — the ResponseCreateSequencer: our adapters already
track `activeResponse` + guard `cancelResponse`, but `injectToolResult` sends `response.create` WITHOUT an
`activeResponse` check, so the "active response" race is *plausible but unproven*. Do NOT keep it P0 on
assertion — first write the failing interleaving test (§"Response-sequencing repro" below); if it reproduces,
promote to P0; if not, the minimal fix is to gate `response.create` on `!activeResponse` and it drops to P1.
**P1** — P1-1 thread `responseId` through audio/turn/transcript events (bridge uses provider id, not self-minted
contextId); P1-2 typed error-category enum (drop `recoverable` boolean + prose reconstruction); P1-3 `usage`
event; P1-4 circuit breaker (`maxReconnectDurationMs` — flapping just above `minStableMs` currently reconnects
forever, `index.ts:322`).
**P2** — P2-1 outbound `send()` backpressure (bufferedAmount high-water); P2-2 replay TTL (stale-speech guard);
P2-3 `setMuted/muted` + lazy `headers` thunk; P2-4 consolidate base64/crypto into one runtime shim.

## New transports — build order A → B → C
- **A. Generic inbound `TransportLayer` (BUILD FIRST).** Unify `edge.ts` + carriers onto the better-factored
  `TransportAdapter<TState>` (`transport-host.ts:53`) **re-typed against `ManagedSocket`** so one host runs Node
  carriers AND the Workers edge; `edge.ts` becomes an adapter, not a parallel host. Medium effort, no new deps,
  de-risks B. Preserve DO hibernation + resume-window.
- **B. WebRTC (BUILD SECOND).** Biggest capability gap + lower browser latency. Reference: `openaiRealtimeWebRtc.ts`
  (data channel `oai-events`, native media tracks, SDP POST, `output_audio_buffer.clear` for interrupt). Inbound
  (browser→Syrinx) adapter + outbound OpenAI-WebRTC `RealtimeAdapter`. **Not workerd-native** (`RTCPeerConnection`
  absent) → terminates at a Node/SFU; decide ingress topology first. Large; heavy deps (werift/node-datachannel).
- **C. SIP (LAST/defer).** Their elegant insight (`openaiRealtimeSip.ts`): SIP is a WS **control plane** attached
  by `callId`; `sendAudio` disabled (media owned by the SIP leg). Thin control-only adapter IF we add a media
  gateway; else full RTP stack. We already cover telephony via carrier WS media-streams — defer to direct-trunk need.

## Seam decision
**Converge the two INBOUND hosts onto one `ManagedSocket`-typed `TransportLayer` (route A). Keep the OUTBOUND
`RealtimeAdapter` and the `SocketFactory` as separate seams. Do NOT collapse all three** into one mega-interface
like theirs — their single transport conflates provider-connection + session-command because they're single-model;
we're bi-model + provider-neutral, so those are genuinely different concerns (earned separation, not duplication).
Enrich the `RealtimeAdapter` events (responseId/usage/typed-errors/mute) but keep its 5-method + AsyncIterable shape.

## Top 3 next actions + spike
- **Spike:** re-type `TransportAdapter<TState>` against `ManagedSocket` and fold the Workers `edge.ts` into ONE
  adapter for the browser-inbound path; prove one host runs a Node carrier + the Workers edge with
  `edge.test.ts`+`transport-host.test.ts` green and DO hibernation intact. Validates route A + the seam decision.
- **1.** P0-1 + P0-3 ws reconnect hardening (handshake deadline + real liveness probe) — the evidenced bugs.
- **2.** The response-sequencing repro (§ revisions) — write the failing interleaving; sequencer only if it reproduces, else the one-line `!activeResponse` gate (P1).
- **3.** Inbound auth (R-04) — promote to P0 if the edge is reachable by untrusted clients; then route A once the spike proves the shape; WebRTC (B) only after A + its topology DR (R-07).

---

## Staff-architect review revisions (codex high, not-ready → addressed)

The review upheld the map but flagged the plan as not execution-ready as a SPEC. Corrections applied above
(R-03 count, R-01 P0 re-rank/R-02 gate). Additions below close the remaining gaps.

### Response-sequencing repro (R-02) — gate before building the sequencer
Concrete interleaving to reproduce against OpenAI + Grok adapters (and Grok reduced-caps): (1) front model
opens response A (`response.created`, `activeResponse=true`); (2) user barges in → `interrupt.tts` →
`cancelResponse` sends `response.cancel`; (3) before the provider's `response.done`/cancelled arrives, the
bi-model delegate finishes and `injectToolResult` sends `function_call_output` + `response.create` while a
response is still server-side-active → expect "conversation already has an active response". Tests required:
cancel-before-create, tool-result-after-`response.done`, disconnect releases waiters, Grok blocking-tools +
no-truncate path. If it reproduces → port the sequencer (P0); else → gate `response.create` on `!activeResponse` (P1).

### Inbound auth/authz (R-04) — MISSING from the original plan; add as P0/P1
The plan covered outbound provider sockets but NOT inbound (browser/edge clients hitting our `/ws`). Add:
an auth option on the inbound host (bearer/ephemeral-token/HMAC), rejection BEFORE `sessionStore.lease`/
`createSession` (`edge.ts`), and tests for missing/invalid/valid creds on Node + Workers. P0 if any non-trusted
client can reach the edge; P1 if currently only behind a trusted proxy (state which).

### Workers-edge downlink backpressure (R-05)
Original P2-1 covered OUTBOUND provider `send()`; the inbound Workers edge (`edge.ts` → `socket.send`) has no
downlink shedding (the Node `transport-host.ts` checks `bufferedAmount`; the edge doesn't). Add a
`ManagedSocket`-compatible high-water/pacing strategy so a slow client closes/sheds instead of unbounded send.

### Route A migration invariants + rollback (R-06)
Before re-typing `TransportAdapter` against `ManagedSocket` and folding `edge.ts`, enumerate invariants with
named tests: DO `acceptWebSocket`/hibernation + heartbeat, resume-window state + replay, recorder finalization,
Node carrier graceful close, admission control, startup-timeout, max-session, max-inbound, idle. Rollback =
keep the two hosts behind a flag until the unified host passes all of the above.

### Latency-gate methodology (R-08) — replaces "~0ms added"
Measure, don't assert: fixed short fixtures (`SYRINX_WS_MAX_TURNS=1`), N≥20 runs, report P50/P95 for LLM-TTFT,
first-audio, barge-in onset→media-silent, reconnect recovery, + CPU/mem on Node and Workers. Pass = no P95
regression vs the pre-change baseline. (Supersedes the "~0ms" claim in the backlog header.)

### Event-schema migration (R-09)
Adding `responseId`/`usage`/typed-errors/transcript item-ids to `RealtimeEvent` flows through `RealtimeBridge`
→ bus packets → browser client message validation → existing tests. Make new fields OPTIONAL/additive; version
the bus packets if a consumer asserts exact shape; land adapter→bridge→client in that order with tests at each.

### WebRTC topology (R-07) — OPEN DECISION (needs owner input before route B)
`RTCPeerConnection` is not workerd-native, so browser→Syrinx WebRTC must terminate at a Node/SFU, not the DO.
Decision record needed: ingress placement (Node process vs managed SFU), media recording path, NAT/TURN infra,
auth (ephemeral), latency measurement vs WS, and fallback to the current WS transport. Do not start route B
until this DR is signed off.

### Net verdict
The plan is a sound roadmap; with the above it is execution-ready. Recommended first work remains the two
evidenced P0 bugs (handshake deadline + liveness probe) + the sequencing repro — auth (R-04) rises to P0 iff
the edge is reachable by untrusted clients.
