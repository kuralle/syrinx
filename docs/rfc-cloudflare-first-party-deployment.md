# RFC: First-party Cloudflare deployment (browser + telephony)

> **Status:** Draft · **Owner:** octalpixel · **Date:** 2026-06-13
> **Scope:** BOTH browser/edge voice AND telephony parity.
> **Builds on:** `@kuralle-syrinx/cf-agents` (`withVoice(Agent)`, shipped on `feat/agents-with-voice`),
> [`rfc-realtime-bridge.md`](./rfc-realtime-bridge.md), [`rfc-reasoner-bridge.md`](./rfc-reasoner-bridge.md),
> [`rfc-ws-transport-hardening.md`](./rfc-ws-transport-hardening.md).

This RFC is the build contract for promoting Cloudflare from a **spike** target to a **first-party,
maintained, CI-tested, documented runtime** — a peer to the Node `server-websocket` host. Section 9 (WBS)
is the delegation plan.

---

## 1. Context & problem

Cloudflare runs Syrinx today only as a **spike** (`packages/server-workers`, `server-workers-mastra`,
`fly.*-spike.toml` siblings). Two problems block first-party status:

1. **Duplicated, hand-rolled host machinery.** `server-workers` and `server-workers-mastra` are raw
   Durable Objects that re-implement what the Cloudflare `agents` SDK provides natively: an
   `alarm-scheduler.ts` (**two copies**), a `durable-session-store`/`durable-run-store`, manual
   `webSocketMessage/Close/Error` plumbing, and a `ws.close(1012, "session_evicted_reconnect")` orphan
   handler that papers over mid-call DO eviction. `cf-agents` `withVoice(Agent)` proved the Agent-native
   path: reuse the SDK's hibernation, `keepAlive()` lease, `Connection`, and SQL instead.
2. **No telephony on the edge host.** The CF host speaks only the browser/edge protocol. The Node host
   does Twilio/telnyx (`server-websocket/edge-twilio`, `telnyx`, `smartpbx`). Without telephony parity,
   CF is "first-party for browser voice only" — insufficient to replace the Node host for phone
   deployments. **This RFC closes that gap (scope = both).**

The architectural fit is strong: one Durable Object per voice session maps onto Syrinx's session
boundary exactly — per-session isolation, hibernation between turns, `keepAlive()` for the live call,
SQL/state for resume, global edge for low first-hop latency. The `agents` SDK hands all of that over.

## 2. Goals / non-goals

**Goals**
- G1. `server-workers` (browser/edge + Twilio) rebuilt as a thin `cf-agents` `withVoice(Agent)` consumer;
  delete both `alarm-scheduler.ts` copies, the durable session store, the manual WS lifecycle, and the
  eviction-orphan workaround. Behaviour preserved; proven by the existing live smokes.
- G2. **Telephony parity**: a Twilio/telnyx media-stream front for the `cf-agents` host, wiring the
  existing `@kuralle-syrinx/server-websocket/edge-twilio` runner over the Agent's `Connection`.
- G3. The brain stays a **parameter**: `reasoner` is any of `fromKuralleRuntime` / `fromStreamText` /
  `fromMastraAgent`. `server-workers-mastra`'s voice host folds into the same `withVoice` shape.
- G4. A **deployment template** (`examples/cloudflare/`) + a Diataxis "Deploy Syrinx on Cloudflare"
  how-to: wrangler config, DO/R2/Vectorize bindings, secrets, migrations.
- G5. A **live CI smoke** against a deployed worker that guards the ~800 ms–1 s v2v budget at the edge.
- G6. First-party **client**: `browser-client` transport on `partysocket` (auto-reconnect, backoff,
  buffering) — consistent resilience with the partyserver-based host.

**Non-goals**
- No change to the `cf-agents` public API surface beyond additive options (telephony front, recorder).
  The package stays narrow (peer-deps `agents`); it is **not** renamed to `@kuralle-syrinx/cloudflare`
  (that would re-couple consumers to `agents` and break the quarantine the package exists for).
- No WebRTC/SFU path (browser uses the WS edge protocol; SFU is a later RFC).
- No new providers; no kernel changes.

## 3. Prior art (read before designing)

- `packages/cf-agents/src/{with-voice,connection-socket,build-session}.ts` — the mixin, the
  `Connection`→`ManagedSocket` pump, the realtime/cascaded assembler. The host pattern of record.
- `packages/server-workers/src/{worker,worker-realtime,alarm-scheduler,durable-session-store}.ts` — what
  gets deleted/replaced. `worker.ts:109` is the eviction-orphan workaround `keepAlive()` removes.
- `packages/server-websocket/src/{edge,edge-twilio,telnyx,twilio,smartpbx}.ts` — the runner +
  telephony protocol the new front wraps. `runVoiceEdgeWebSocketConnection` and the twilio upgrade.
- Cloudflare `agents` SDK (cloned, studied): `Agent` extends partyserver `Server`; `keepAlive()` is a
  ref-counted alarm lease; hibernation-safe `onConnect/onMessage/onClose`; `routeAgentRequest`.
- PartyKit `partysocket` (cloned): reconnecting WebSocket — auto-reconnect, exponential backoff,
  message buffering while disconnected, `connectionTimeout`, `minUptime` stability. The browser client
  today opens a bare `new WebSocket` with no resilience (`browser-client/websocket-transport.ts:44`).
- `docs/latency-budget.md` — the v2v budget the edge smoke must guard.

## 4. Architecture

Three layers; only the host is wrong today.

```
Brain (Reasoner, host-agnostic)   kuralle | aisdk | mastra   →  Syrinx Reasoner   [keep as-is]
        │  reasoner: (env,ctx) => Reasoner
        ▼
Host (cf-agents withVoice over the agents SDK Agent)         [ONE host, brain is a param]
   ├─ browser/edge front   → runVoiceEdgeWebSocketConnection  (shipped)
   └─ telephony front      → edge-twilio runner over Connection (G2, new)
        │  Connection ⇄ ManagedSocket (hibernation-safe pump)
        ▼
Client   browser-client on partysocket  |  Twilio/telnyx media stream   [G6]
```

### 4.1 Host rebuild (G1)
`server-workers` `VoiceConversation` / `RealtimeVoiceConversation` become:

```ts
export class VoiceConversation extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: cascadedOrRealtimePipeline(env),
  reasoner: (env, { sessionId }) => createCascadeKuralleReasoner(env, { sessionId }),
  recorder: (env, { sessionId }) =>
    env.RECORDINGS ? new R2EdgeRecorder({ bucket: env.RECORDINGS, sessionId, startedAtMs: Date.now() }) : undefined,
}) {}
// worker default.fetch → routeAgentRequest(request, env)
```

Deletes: `alarm-scheduler.ts` (×2), `durable-session-store.ts`, `durable-run-store.ts`, the manual
`webSocketMessage/Close/Error` + `acceptWebSocket`, and the 1012 eviction-orphan branch (the
`keepAlive()` lease holds the isolate warm for the call, so mid-call eviction — and the workaround for
it — disappears). `live-session.ts`, `live-realtime-session.ts`, `r2-recorder.ts`,
`kuralle-realtime-agent.ts` stay (pipeline/brain, not host).

### 4.2 Telephony front (G2 — the parity gap)
`cf-agents` gains an optional `transport: "edge" | "twilio"` (or a `front` discriminator). When
telephony, the mixin drives `createTwilioEdgeWebSocketUpgrade` / the telnyx runner over the Agent's
`Connection`-as-`ManagedSocket` instead of `runVoiceEdgeWebSocketConnection`. The media-format work
(μ-law 8 kHz ↔ engine PCM16, the `mulaw-passthrough` plan) already lives in `server-websocket`; this is
wiring, not new DSP. Routing: a `/incoming-call` TwiML/telnyx-texml handler returns a `<Stream>` to
`wss://…/agents/voice-conversation/<callSid>/twilio` (mirrors the `openai-sdk/call-my-agent` example).

### 4.3 keepAlive + resume model
Hold one `keepAlive()` lease per connection for the call (cf-agents already does). The lease prevents
mid-call hibernation, so the in-memory provider sockets survive the call. Across a true reconnect
(client drop), resume by `sessionId` (`?sessionId=` on the WS URL) against the per-DO session store —
the lease is released between connections, so the DO can hibernate when idle. Telephony reconnects use
the `callSid` as the stable `sessionId`.

### 4.4 Deployment template + client (G4, G6)
`examples/cloudflare/` = a complete deployable worker (both DO classes, wrangler.jsonc with DO + R2 +
Vectorize bindings + migrations, `.dev.vars.example`, the `<Stream>` handler) + a `partysocket`-backed
browser client. This is the artifact "first-party" means — clone, set secrets, `wrangler deploy`.

## 5. Cost model (per 8-min voice session)

Grounded in current pricing (2026-06-13; ±2× ballpark — STT VAD-gating and realtime context-replay are
the swing factors). **Headline: Cloudflare infra is ~0.5–1% of the bill; the AI providers are ~99%.**

**Cloudflare infra (Workers Paid; mode-independent):**
| Item | Calc | Cost/session |
|---|---|---|
| DO duration (128 MB, keepAlive held 480 s) | 480 s × 0.125 GB × $12.50/M GB-s | **$0.0008** |
| DO requests (~24k inbound WS frames ÷ 20:1 + ~30 alarms) | ~1,230 × $0.15/M | **$0.0002** |
| SQLite state rows + R2 recording write/storage (optional) | handful of rows + ~30 MB | **<$0.0002** |
| **CF infra total** | | **≈ $0.001 / session → ~$1 per 1,000 calls** |

**AI providers (the real cost; pick one pipeline):**
| Pipeline | Components (8 min, ~40% user / ~45% agent speech) | Cost/session |
|---|---|---|
| **Cascaded** (Deepgram Nova-3 STT + small LLM + Aura-2/Cartesia TTS) | STT 8 min×$0.0048=$0.038 (VAD-gated 4 min=$0.019); TTS ~3,300 chars×$0.030/1k=$0.099; LLM ~$0.02–0.05 | **≈ $0.13–0.19** |
| **Realtime — Gemini Live** (native audio) | in 8 min×$0.005=$0.040; out 3.5 min×$0.018=$0.063; text/context ~$0.01–0.03 | **≈ $0.11–0.15** |
| **Realtime — OpenAI gpt-realtime-mini** ($10/$20 per 1M audio tok) | measured ~$0.16–0.33/min × 8 | **≈ $1.3–2.6** |
| **Realtime — OpenAI gpt-realtime-2** ($32/$64 per 1M audio tok, ~3.2× mini) | measured ~$0.51–1.06/min × 8 | **≈ $4–8.5** (premium) |

> Realtime per-session cost is dominated by **per-turn context replay** (each turn re-sends accumulated
> audio/text as input), so it scales with system-prompt size and conversation length, not just talk-time.
> **Prompt caching** (cached input ~10× cheaper) pulls these toward the low end; a large system prompt
> with no caching pushes them past the high end. Treat realtime numbers as ±2× and caching-dependent.

**Telephony leg (add if PSTN):** Twilio voice ~$0.0085/min + Media Streams ~$0.004/min → ~$0.10/8-min
call; telnyx ~30–50% cheaper. (Browser/WebRTC: $0.)

**Per-1,000 8-min sessions:** CF infra ~$1 · cascaded ~$150 · Gemini Live ~$130 · gpt-realtime-mini
~$1,300–2,600 · gpt-realtime-2 ~$4,000–8,500 · +~$100 if all PSTN. **Pipeline choice swings total
~10–50×; CF hosting is rounding error.**

## 6. Risks / open questions
- **R1 — Realtime cost.** OpenAI realtime is ~10–20× cascaded/Gemini. Default the first-party template to
  cascaded or Gemini Live; document OpenAI as opt-in premium.
- **R2 — DO eviction on long silence.** keepAlive holds the isolate, but a wedged/abandoned call must
  release the lease (idle timeout) so the DO can hibernate — verify the edge runner's idle path fires.
- **R3 — Cold-start first-hop.** Edge isolate cold start adds to first-audio latency; the CI smoke must
  measure cold and warm separately against the budget.
- **R4 — Telephony media format** (μ-law 8 kHz): confirm the `mulaw-passthrough` path works unchanged
  through the mixin; resample only where required.
- **R5 — Multi-connection per DO.** cf-agents keys controllers by `connection.id`; confirm telephony
  (one call = one DO) and any browser multi-tab case behave (distinct `sessionId`).

## 7. Acceptance criteria
- [ ] `server-workers` runs on `withVoice(Agent)`; `alarm-scheduler.ts` (×2) + durable stores + the 1012
      orphan branch deleted; `pnpm -r typecheck` + tests green.
- [ ] Telephony front: a Twilio (and telnyx) call reaches the agent and completes a turn end-to-end.
- [ ] `examples/cloudflare/` deploys via `wrangler deploy` and serves a browser + a phone call.
- [ ] Live CI smoke guards the v2v budget against the deployed worker (cold + warm).
- [ ] `browser-client` reconnects across a forced socket drop via partysocket (buffered, resumed).
- [ ] "Deploy Syrinx on Cloudflare" how-to merged; CF removed from "spike-only" in the docs/memory.

## 8. Rollout
Breaking, multi-package → ships in **3.0.0**. Gate every WBS row behind the existing live smokes
(latency gate with `SYRINX_WS_MAX_TURNS=1`, telnyx/twilio emulator smokes) before merge. Deploy
`--no-cache` (per project rule). Keep the Node host unchanged as the fallback during transition.

## 9. WBS (delegation plan — ordered)
| # | Chunk | DoD |
|---|---|---|
| W1 | `server-workers` browser/edge → `withVoice(Agent)`; delete alarm-scheduler #1 + durable-session-store + manual lifecycle + 1012 branch | typecheck+tests green; websocket-university + latency smokes pass |
| W2 | Fold `server-workers-mastra` voice host into `withVoice` (`reasoner: fromMastraAgent`); delete alarm-scheduler #2; move run-store onto Agent SQL | mastra suspend/resume smoke passes on Agent SQL |
| W3 | Telephony front in `cf-agents` (`transport: "twilio"|"telnyx"`) wrapping `edge-twilio` over `Connection` | twilio + telnyx emulator smokes pass via the mixin |
| W4 | R2 recorder as a `cf-agents` subexport; resume-by-sessionId/callSid verified | recorder-coherence smoke passes |
| W5 | `examples/cloudflare/` template (wrangler, DO/R2/Vectorize bindings, secrets, `<Stream>` handler) | `wrangler deploy --dry-run` + a real deploy serve a browser + phone call |
| W6 | `browser-client` transport → partysocket | forced-drop reconnect smoke passes |
| W7 | Live CI smoke against a deployed worker (cold+warm v2v) | budget guarded in CI |
| W8 | "Deploy on Cloudflare" how-to; promote CF off spike-status in docs | docs merged |

W1–W2 are the dedup; W3 is the parity gap; W5/W7/W8 are what make it "first-party."
