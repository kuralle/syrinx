# Serverless / Edge Portability Review — Voice-Engine 36h Sweep

> **⚠️ RESOLVED (2026-06-05) — this is the original diagnosis, kept as the record.**
> The Cloudflare Workers verdict below (§1: "NO — cannot run today") has since been
> closed. The engine now runs on Cloudflare Workers: one hibernatable Durable Object
> per conversation (`@asyncdot/voice-server-workers`), inbound `WebSocketPair` seam,
> timers→DO alarms via a `Scheduler`, `DurableObjectSessionStore`, lazy provider
> sockets, and `onnxruntime-web` for VAD. It is **deployed and live-tested** end-to-end
> with real Deepgram + OpenAI + Cartesia, plus R2 call recording and DO keep-alive.
> See `serverless-edge-port-implementation-notes.md` for the resolution. The blocker
> matrix and per-target checklists below remain accurate as the *map of what was fixed*
> (Cloudflare items closed; Vercel/Lambda not pursued).

**Scope:** `git diff 2b5e33f..HEAD` (29 changed source files under `packages/*/src/*.ts`). **Targets, in priority order:** Cloudflare Workers (the intended deployment), Vercel (Edge / Node serverless / Sandbox), AWS Lambda. **Reference architecture:** Cloudflare agents `withVoice` Durable-Object-per-conversation (see `knowledge-research/notes/ARCH-09-rapida-cloudflare-runtimes.md`).

> Produced by a multi-agent review workflow (5 runtime dimensions → adversarial per-finding verification → synthesis). 33 findings, 30 upheld, 3 rejected.

---

## 1. Verdict

**Cloudflare Workers (target): NO — cannot run today.** The inbound transport (`voice-server-websocket`) is a Node `node:http` `createServer().listen()` + `ws` `WebSocketServer` host (WS-01/02/03). `nodejs_compat` does not polyfill net/tls/http *servers* nor the `ws` server class, so the package fails at module evaluation — long before any session, timer, or state logic is reached. Compounding this, every provider plugin statically imports `createNodeWsSocket` purely as a default parameter, dragging the Node `ws` graph into the bundle even when a Workers adapter would be injected (WS-NODE-01), and the local VAD / turn-detection plugins load native N-API addons + read `.onnx` models from disk (NATIVE-01/02/03, FS-01). The single biggest reason: **there is no inbound WebSocket-server seam; the code only has an outbound (client) seam, and the inbound host is hard-bound to Node.**

**Vercel: PARTIAL.** *Edge:* NO — same V8-isolate constraints as Workers (no Node server, no native addons, no fs). *Node serverless:* NO for the persistent-duplex role — a request-scoped function cannot hold a long-lived listening WS server or persist a socket across invocations (WS-01); it works only as stateless per-event compute. *Sandbox:* mostly YES — a Firecracker microVM running real long-lived Node; `listen()`, native addons, disk models, and `setTimeout` pacing all work as-is. The single biggest reason Vercel is not a drop-in: **functions cannot host the duplex socket server; only Sandbox can, and Sandbox is not the serverless model.**

**AWS Lambda: NO for the live voice path.** No persistent inbound socket (needs API Gateway WebSocket, event-per-frame), no background timer after the response returns (freeze/thaw kills all watchdogs, pacing, keepalives, and recovery probes — TIMER-02/03/04/05, STATE-06), and the 15-min cap. Real-Node plugins *load* (native VAD/opus are fine on Lambda), but the topology — long-lived listening server + free-running timers + in-process session registry — is structurally incompatible. The single biggest reason: **the engine assumes a continuously-running process holding the duplex socket and firing timers between packets; Lambda has neither.**

---

## 2. Hard-Blocker Matrix

Upheld throw-on-load / cannot-stand-up blockers, critical→low. Only blockers that genuinely prevent the code from loading/running on a target remain here; findings downgraded by their skeptic verdict moved to §3.

| ID | File:line | Breaks on | Why | Severity |
|----|-----------|-----------|-----|----------|
| **WS-01 / NODE-02** | `voice-server-websocket/src/index.ts:150,352` (`createServer()` … `httpServer.listen()`); imports `node:http` + `ws` at `:4-5` | CF Workers, Vercel Edge, Vercel Node, Lambda | Binds a long-lived `node:http` server + `ws` `WebSocketServer`. `nodejs_compat` provides no http/net/tls *server* nor the `ws` server class → fails at eval on Workers/Edge. Vercel-Node/Lambda cannot bind an inbound listening socket at all. *(Vercel Sandbox excluded — real Node `listen()` works.)* | **Critical** |
| **WS-02** | `voice-server-websocket/src/twilio.ts:120,401`; `telnyx.ts:139,421`; `smartpbx.ts:113,355` | CF Workers, Vercel Edge, Vercel Node, Lambda | Twilio/Telnyx/SmartPBX each replicate the same `createServer()/listen()` + `ws` server. The in-window DTMF parsing is itself portable (pure `parseDtmfDigit` + `bus.push`) but is only reachable via `wsServer.on("connection")`, which never fires on edge because the host can't stand up. | **Critical** |
| **WS-03** | `voice-server-websocket/src/websocket-upgrade.ts:35,47,85` | CF Workers, Vercel Edge, Vercel Node, Lambda | Admission/routing hangs off the `node:http` `"upgrade"` event + `node:net` `Socket` + `ws.handleUpgrade`. Workers inbound upgrade is `fetch()` → `new Response(null,{status:101,webSocket})` from a `WebSocketPair`; there is no upgrade event, no raw Socket, no `handleUpgrade`. The existing `voice-ws/workers.ts` seam is **outbound-only** — no inbound counterpart exists. | **Critical** |
| **WS-NODE-01** | `voice-tts-cartesia/src/index.ts:28,35`; `voice-stt-deepgram:36,86`; `voice-stt-google:33,61`; `voice-tts-deepgram:37,48` | CF Workers, Vercel Edge | Each plugin statically imports `createNodeWsSocket` *solely* as a default param value. A referenced default param can't be tree-shaken, so `voice-ws/node.ts` → `import WebSocket from "ws"` → `require('net'/'tls'/'http')` is unconditionally bundled even when a Workers factory is injected. **This is the one finding that defeats the repo's own portability seam.** | **Critical** |
| **STATE-01** | `voice-server-websocket/src/session-store.ts:40`; default at `index.ts:157` | Vercel Node, Vercel Sandbox, Lambda | The only `SessionStore` impl is an in-process `Map` holding live `VoiceAgentSession` objects. Each cold container/invocation gets an empty Map; a resumed/second connection landing elsewhere finds nothing → state silently lost (`release`/`update` early-return on miss). *(On Workers/Edge the module never loads — that's WS-01, not this.)* | **Critical** |
| **NATIVE-01 / NODE-03** | `voice-vad-silero/src/index.ts:67-68` (`await import("onnxruntime-node")` → `InferenceSession.create`) | CF Workers, Vercel Edge | `onnxruntime-node@1.24.3` is a dlopen'd N-API addon; isolates have no native-addon loader (`nodejs_compat` never provides N-API). Dynamic import means the bundle builds but `initialize()` throws on first VAD use — VAD is on the inbound audio hot path, so barge-in/turn-detection cannot run on the target. *(Real-Node targets load fine — packaging only.)* | **Critical** |
| **NATIVE-02** | `voice-turn-pipecat/src/index.ts:11,72,87-88` | CF Workers, Vercel Edge | Two prongs: (1) same `onnxruntime-node` N-API throw; (2) **static** top-level `import { WhisperFeatureExtractor } from "@huggingface/transformers"`, eagerly instantiated — its dep tree pulls `sharp@^0.34.5` (native libvips `.node`) + onnxruntime. A static import forces the edge bundler to resolve sharp's native binary at **build time** (unbundlable) and blows past the Workers compressed-size limit. | **Critical** |
| **NATIVE-03** | `voice-server-websocket/src/smartpbx.ts:6` (`@evan/opus`) + the package's `node:http`/`ws` host | CF Workers, Vercel Edge, Vercel Node, Vercel Sandbox, Lambda | Two stacked blockers: (1) `@evan/opus` loads its wasm via `fs.readFileSync(__dirname)` / its `.node` via `require` — both absent on Workers/Edge (breaks edge only); (2) the Node `ws`-server transport host (breaks all 5). Union = all targets, two distinct causes. | **Critical** |
| **FS-01** | `voice-vad-silero/src/index.ts:30`; `voice-turn-pipecat/src/index.ts:44` | CF Workers, Vercel Edge | `InferenceSession.create(modelPath)` reads `../models/*.onnx` from disk via fs. No fs on isolates; even after a WASM swap, the model must be fetched as bytes / bound as an asset, not loaded by path. (Secondary to NATIVE-01/02 but independently fatal on edge. Note: `fileURLToPath`/`import.meta.url` itself is *not* the blocker — `node:url` is covered by `nodejs_compat`.) | **High** |

---

## 3. Degradations (work, but violate the serverless model)

These do **not** throw on the target where listed — they register/run but silently lose the guarantee they were built to provide (a "fail-open" the 36h hardening was specifically meant to close).

| ID | File:line | Affected targets | What silently breaks | Sev |
|----|-----------|------------------|----------------------|-----|
| **NODE-01 / TIMER-01 / WS-05 / STATE-03** | `voice-server-websocket/src/websocket-lifecycle.ts:67-91` (`process.once("SIGTERM"/"SIGINT")`); drain walks `sessionStore.listAll()` at `index.ts:379` | Vercel Node, Lambda (weakly Sandbox) | `installGracefulShutdown` (new this window) registers POSIX signal handlers to "drain, don't kill". No serverless platform delivers SIGTERM to user code with a usable async window, so the handler never fires — deploys/scale-downs **hard-cut active calls**, the exact failure it was meant to prevent. On Workers/Edge subsumed (package unloadable). `listAll()` over a per-isolate Map can never drain the fleet. | High |
| **TIMER-02 / STATE-06** | `voice/src/voice-agent-session-util.ts:104,122,143,168` (4 watchdogs; input-cadence self-re-arms at `:193`, re-armed per packet at `voice-agent-session.ts:555`) | CF Workers, Lambda, Vercel Node, Sandbox | STT force-finalize, VAQI missed-response, TTS-stall, input-cadence watchdogs are **idle-fire** timers that must fire *between* packets. On Lambda they never fire post-response; on Workers a `setTimeout` doesn't survive the request boundary (needs DO `alarm()`); in a DO, in-memory timers die on hibernation. Stall/missed-response safety is silently lost. | High |
| **TIMER-04 / WS-04** | `voice-server-websocket/src/paced-playout.ts:143` (per-frame `setTimeout` re-arm) | CF Workers, Lambda, Vercel Node | The ~20ms realtime playout clock runs for the whole utterance. On Workers it *runs* while a socket keeps the isolate/DO resident — but any armed `setTimeout` **suppresses DO hibernation entirely** (defeats the cost model) and is dropped silently on eviction. On Lambda the loop can't continue after the handler returns. *(Sandbox excluded — long-lived microVM.)* | High |
| **TIMER-05** | `voice-ws/src/index.ts:354` (`setInterval` keepalive; active via deepgram `keepAliveIntervalMs:3000`, cartesia) | CF Workers, Lambda, Vercel Node | Outbound provider-socket keepalive `setInterval`. On Lambda stops after response → upstream STT/TTS idles out; on Workers needs DO `alarm()` across requests. *(Sandbox excluded.)* | Medium |
| **TIMER-06 / WS-07** | `voice-server-websocket/src/websocket-lifecycle.ts:39` (`socket.ping()`/`"pong"`/`socket.terminate()` + `setInterval`); wired per-socket at `transport-host.ts:186` | CF Workers (API-absence); Vercel Node/Lambda (model) | `.ping()`/`.terminate()`/`.on("pong")` are `ws`-library methods absent from the standard WebSocket used by `WebSocketPair`. Free-running per-connection interval can't tick in a hibernatable DO. On full-Node targets the API exists but the always-on-process assumption is wrong. | Medium |
| **TIMER-03** | `voice/src/provider-fallback.ts:69,71` (self-re-arming recovery probe) | CF Workers, Lambda, Vercel Node | A provider marked unavailable recovers **only** via a `setTimeout` chain. Post-response freeze (Lambda/Vercel-Node) or isolate eviction (Workers) → provider stays unavailable forever; controller permanently degrades to backup. *(Latent: no internal caller wires `ProviderFallback` in yet. Sandbox excluded.)* | Medium |
| **STATE-02** | `voice-server-websocket/src/index.ts:189,285` (`lease`/`release`, `DEFAULT_RESUME_WINDOW_MS=15s`) | CF Workers, Vercel Node, Sandbox, Lambda | 15s resume-on-reconnect retains the warm session in the in-process Map with a `closeTimer`. Behind any load balancer the reconnect hits a different instance → cold session spun up, retained one leaks. The `sessionStore` seam (`index.ts:157`) is the exact remediation hook. | High |
| **STATE-04** | `voice/src/voice-agent-session.ts:683` + fields at `:210-228` | CF Workers, Lambda | Per-turn dedup guards (`lastFinalizedContextId`, `firstTtsAudioFired`, `interruptedGenerationContextIds`, `fallbackInjectedContexts`, `turnUserStoppedAtMs`) are plain heap with no write-through to DO storage. Correct *today* (live timers keep the object resident), but blocks ever enabling DO hibernation and can't cross Lambda invocations. | Medium |
| **STATE-05** | `voice/src/provider-fallback.ts:20`; `observability.ts:71`; `turn-metrics.ts:115` | CF Workers, Lambda, Vercel Node, Edge | Per-instance health/metric state never aggregates across the fleet: circuit-breaker has no fleet-wide effect; `InMemoryMetricsExporter` accumulates into arrays that vanish on recycle (only non-noop sink shipped). DI seams exist (`MetricsExporter` default `noopMetricsExporter`; `persistedTurns` injectable) — gap is *missing impls*, not broken code. | Medium |
| **WS-06** | `voice-server-websocket/src/index.ts:376,386,390` (`wsServer.clients` → `terminate()` → `wsServer.close()`) | CF Workers, Vercel Edge/Node, Lambda | Central client-registry "one process owns all calls" shape — the exact anti-pattern vs DO-per-conversation. `terminate()` is `ws`-only; `wsServer.close()` has no Workers equivalent. On Workers/Edge manifests as a load-time failure (subsumed by WS-01). | High |

**Already-portable (verified clear, no action):** `TIMER-07` monotonic clock `performance.timeOrigin + performance.now()` (`observability.ts:6`); `WS-08` voice-ws replay-on-reconnect (drives `ManagedSocket`, standard timers only — caveat: replay buffer is per-connection state that must live in the DO, not module scope); `SDK-OK-01` AI-SDK OpenAI bridge + Gemini TTS (fetch/ReadableStream only — caveat: `Buffer.from` at `voice-tts-gemini/src/index.ts:200` needs `nodejs_compat` or a pure-web base64 swap).

---

## 4. The Architectural Gap

The current engine is a **single long-lived Node process that owns every conversation**: one `http.Server` + `ws.WebSocketServer` binds a port (`index.ts:150,352`), holds all client sockets in `wsServer.clients`, keeps a process-local `Map` of live `VoiceAgentSession` objects (`session-store.ts:40`), fires free-running `setTimeout`/`setInterval` watchdogs and pacing clocks between packets, and drains on `SIGTERM`. The Cloudflare agents reference (ARCH-09) is the inverse on every axis: **one hibernatable Durable Object per conversation** — the DO id *is* the conversation, state lives in `ctx.storage.sql`, and the platform (not the operator) manages scale-down via hibernation. The distance is not a patch; it is a topology inversion. Four concrete reshapes:

- **WS server → `WebSocketPair` + DO.** Replace `createServer().listen()` + `ws.handleUpgrade` (WS-01/02/03) with a `fetch()` handler that does `const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]); return new Response(null,{status:101, webSocket: pair[0]})`, then drives the **same** `TransportAdapter` / `runWebSocketConnection` pipeline (already socket-shaped, not server-shaped — `transport-host.ts:102-125`). This requires a *new inbound seam* mirroring the existing outbound `voice-ws/workers.ts` fetch-upgrade — today's seam dials providers (Deepgram/Cartesia), it does not accept browsers.
- **Free-running timers → DO alarms.** Every `setInterval`/self-re-arming `setTimeout` (TIMER-02/03/04/05/06, STATE-06) becomes `ctx.storage.setAlarm(nearestDeadline)`; the `alarm()` handler recomputes which watchdogs/probes/keepalives are due, fires them, and re-arms. Alarms survive hibernation and bill nothing while idle. The minimal reshape is a `Scheduler` interface (`schedule(key, delayMs, cb)/cancel(key)`) on the watchdog/keepalive/fallback deps: Node impl → `setTimeout`; Workers impl → `setAlarm`. Parallels the existing `node.ts`/`web-socket.ts`/`workers.ts` socket seam.
- **Graceful-drain/SIGTERM → DO hibernation.** `installGracefulShutdown` (NODE-01) and `listAll()`-walk drain (STATE-03) have no serverless analog and need none: a DO survives deploys (in-flight requests complete, then it hibernates), so "drain, don't kill" is *structurally satisfied* per-conversation. There is no fleet-wide registry to walk because each DO owns exactly one call. Keep `installGracefulShutdown` Node-only behind a runtime gate; do not port it.
- **In-memory state → DO SQLite.** `InMemorySessionStore`'s `Map` (STATE-01), the 15s resume window (STATE-02), per-turn dedup guards (STATE-04), and provider-health/metrics (STATE-05) move into `ctx.storage.sql` keyed by conversation/contextId. The `SessionStore` interface (`session-store.ts:26-33`) and `MetricsExporter`/`persistedTurns` DI seams are already clean injection points — what's missing is a `DurableObjectSessionStore` impl and a push-based exporter; no shipped durable impl exists today (grep for `DurableObject`/`ctx.storage`/`WebSocketPair`/`alarm` across `packages/` returns zero).

**Minimal reshape order:** (1) inbound `WebSocketPair`/DO seam in `voice-ws`; (2) `Scheduler` seam for timers→alarms; (3) `DurableObjectSessionStore`; (4) gate the Node-only host (`voice-server-websocket`) and native plugins off the edge build. Steps 1+4 are the gate to *boot* on Workers; 2+3 are the gate to *behave correctly* once booted.

---

## 5. Per-Target Migration Checklists

### (a) Cloudflare Workers — the target

1. **Remove the eager Node default-param import in all 4 provider plugins** — change `socketFactory: SocketFactory = createNodeWsSocket` to `socketFactory?: SocketFactory` and resolve the Node factory via lazy `await import("@asyncdot/voice-ws/node")` only on Node. *(closes WS-NODE-01)*
2. **Add an inbound `WebSocketPair` seam to `voice-ws`** (parallel to outbound `workers.ts`): `fetch()` upgrade → `server.accept()` → `wrapWebSocket` → existing `TransportAdapter`. *(closes WS-01, WS-02, WS-03)*
3. **Host one DO per conversation** (`idFromName(sessionId)`); session state, resume window, per-turn guards in `ctx.storage.sql`. *(closes STATE-01, STATE-02, STATE-04)*
4. **Replace all timers with a `Scheduler` backed by DO `alarm()`** — watchdogs, pacing clock, keepalive, provider-recovery probe, max-session/heartbeat. *(closes TIMER-02, TIMER-03, TIMER-04, TIMER-05, TIMER-06, STATE-06)*
5. **Drop `installGracefulShutdown` + central `wsServer.clients` drain from the edge build**; lifecycle = DO hibernation + alarm. *(closes NODE-01, WS-05, WS-06, STATE-03)*
6. **Swap the ONNX backend to `onnxruntime-web` (WASM)** behind a runtime probe, and load the `.onnx` as bytes from R2/KV/asset binding (not a disk path). Watch the metered-CPU budget for per-512-sample inference; consider running VAD inside the DO once per conversation. *(closes NATIVE-01, NATIVE-02, FS-01)*
7. **Replace `@evan/opus` on edge** with a direct `WebAssembly.instantiate` of the opus wasm (no `fs`/`require`), or move opus transcode off the DO. *(closes NATIVE-03 prong 1)*
8. **Ship a push-based `MetricsExporter`** (OTLP over fetch); never use `InMemoryMetricsExporter` as a sink; point `persistedTurns` at DO storage; promote provider-health to a shared/named DO for fleet-wide breaker effect. *(closes STATE-05)*
9. **Keep portable code as-is**: monotonic clock (TIMER-07), voice-ws replay (WS-08), OpenAI bridge + Gemini TTS (SDK-OK-01) — ensure `nodejs_compat` for `Buffer.from` or swap to `atob`.

### (b) Vercel

- **Edge:** treat identically to Workers — every CF blocker above applies (no Node server, no native addons, no fs). Do **not** attempt to host the duplex socket in an Edge function. *(WS-01, WS-03, NATIVE-01/02, FS-01, WS-NODE-01)*
- **Node serverless:** function is **stateless per-event compute only** — it cannot bind a listening WS server (WS-01) nor hold a socket across invocations. Terminate the persistent leg on a stateful tier (a CF DO or a dedicated always-on socket host) and use the function for signaling/HTTP. Externalize `SessionStore` to Redis/KV (STATE-01/02) and push metrics per-invocation (STATE-05). Watchdogs/pacing/keepalive/recovery cannot run post-response — relocate them with the duplex leg (TIMER-02/03/04/05, STATE-06). `installGracefulShutdown` is inapplicable; gate it off (NODE-01).
- **Sandbox:** runs essentially **as-is** — a long-lived Node microVM. `listen()`, native VAD/opus, disk models, and all `setTimeout`/`setInterval` pacing/watchdogs/keepalives work. Remaining caveat: total session duration cap and that this is not a true serverless cost model.

### (c) AWS Lambda

1. **Front the duplex with API Gateway WebSocket** — `$connect`/`$default`/`$disconnect` invoke the function per frame; there is no in-process listening server or `wsServer.clients` set (`connectionId` addressing replaces the Map). *(closes WS-01, WS-03, WS-06 by re-platforming)*
2. **Externalize all session/resume/turn-guard state** to a shared store keyed by `sessionId`/`connectionId`; the live `VoiceAgentSession` cannot survive freeze. *(closes STATE-01, STATE-02, STATE-04)*
3. **Move every timer off the function** — no callback fires after the response returns. Drain (NODE-01/STATE-03), watchdogs (TIMER-02/STATE-06), pacing (TIMER-04), keepalive (TIMER-05), and provider-recovery (TIMER-03) must live on a stateful pacer (DO/container) or external scheduler (EventBridge/Step Functions wait).
4. **Native plugins technically load** (real-Node, `linux-x64`/`arm64` prebuilts within the 250MB limit) — VAD/turn/opus are packaging concerns, not blockers, on Lambda; the 15-min cap and post-response-timer constraints bear on the *topology*, not the model load. *(NATIVE-01/02/03, FS-01 are degradations here, not blockers.)*

---

## 6. Did the 36h Hardening Help or Hurt Portability?

The recent reliability work **added new serverless degradations** by encoding the long-lived-Node-process model more deeply — every one is a "drain/watchdog/pace assuming a process that lives between packets":

- **Hurt (new in-window blockers/degradations):**
  - `installGracefulShutdown` (`websocket-lifecycle.ts:67-91`) — POSIX `SIGTERM`/`SIGINT` drain that silently never fires on any serverless target. *NODE-01 / TIMER-01 / WS-05 / STATE-03.*
  - Input-cadence watchdog (`ve06-input-watchdog`, `voice-agent-session-util.ts:168`) — a *self-re-arming* perpetual `setTimeout` heartbeat, the canonical thing Workers forbids outside DO alarms. *TIMER-02 / STATE-06.*
  - `ProviderFallbackController` recovery-probe loop (`provider-fallback.ts:69,71`) — self-perpetuating `setTimeout` recovery, dead on freeze-model targets. *TIMER-03.*
  - Resume-window `lease`/`release` call sites (`index.ts:189,285`) — couples 15s warm-resume to landing on the same process. *STATE-02.* (The store *interface* it added is a clean seam.)
  - Per-turn EOS-dedup guards (`voice-agent-session.ts`) — more un-persisted heap state. *STATE-04.*
  - `max-session-duration` `setTimeout` added alongside the heartbeat. *TIMER-06.*

- **Portability-neutral or *helped* (in-window):**
  - Monotonic clock `performance.timeOrigin + performance.now()` (`observability.ts:6`) — web-standard over `process.hrtime()`; portable on all targets. *TIMER-07.*
  - voice-ws replay-on-reconnect (`index.ts:134`) — drives the `ManagedSocket` abstraction, standard timers only, respects the seam. *WS-08.*
  - LLM provider swap `createGoogleGenerativeAI → createOpenAI` (`35601f6`) + Gemini TTS — fetch/ReadableStream only, fully edge-portable. *SDK-OK-01.*
  - DTMF parsing added to twilio/telnyx/smartpbx — the *logic* is runtime-neutral (pure parse + `bus.push`); only its *reachability* is blocked by the surrounding Node host (WS-02).

**Net:** the hardening improved *Node-host* reliability but moved the codebase **further from the edge model** — it added four free-running-timer/signal mechanisms and one more pile of un-persisted heap state, each of which becomes a DO-alarm or DO-SQLite rewrite. The pre-existing critical blockers (the `ws` server host, native VAD/opus, in-memory store, eager Node-factory import) were untouched and remain the gate.

---

## 7. What Was Rejected (do not re-litigate)

- **CLOCK-01 — "monotonic clock breaks on edge."** False. `performance.now()`/`performance.timeOrigin` are web standards on all targets. Only caveat: Workers coarsens `performance.now()` for timing-attack mitigation, degrading sub-ms granularity — immaterial for I/O-dominated voice turns.
- **CRYPTO-01 — "`randomUUID` from `node:crypto` breaks on edge."** False. Covered by `nodejs_compat`, native on Node, and Web Crypto `crypto.randomUUID` on Edge. The real adjacent blocker is the `ws` import (WS-NODE-01), not crypto.
- **TIMER-01 (voice-ws keepalive variant) — "free-running `setInterval` keepalive is a Workers degradation."** Rejected *for the outbound voice-ws socket specifically*: that interval only ticks while an **outgoing** provider socket is open, which already pins the DO non-hibernatable — there is no hibernation window it should have been an alarm for. (The *inbound* server heartbeat in `websocket-lifecycle.ts` is a separate, genuine degradation — TIMER-06.)
- **`fileURLToPath`/`import.meta.url` as the model-path blocker.** Rejected as the *cause*: `node:url` is polyfilled by `nodejs_compat`. The real failures are the native N-API load (NATIVE-01/02) and the fs disk read (FS-01).
- **`@evan/opus` "has no wasm" on edge.** Rejected as stated: it *does* ship `wasm/opus.wasm`. The actual edge-fatal reason is its **loader** (`fs.readFileSync(__dirname)` + CJS `require`) — see NATIVE-03.
- **Several findings claimed as hard-blockers on Vercel-Sandbox / Vercel-Node / Lambda.** Downgraded by verdict: `listen()`, native addons, disk models, and `setTimeout` pacing/watchdogs all *work* on Vercel Sandbox (long-lived microVM) and on full-Node Vercel-Node/Lambda the code *loads* — the failures there are serverless-*model* degradations (state loss, lost timers), not throws.
