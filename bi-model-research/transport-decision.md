# Decision: don't adopt `@openai/agents/realtime` by default — keep our seam, steal the event shapes

> Outcome of the 6-agent `transport-adopt-decision` workflow (2026-06-06): map both stacks → 3-lens judge
> panel → synthesis. Grounding: [`openai-agents-transport-notes.md`](./openai-agents-transport-notes.md),
> the codex review WBS (`.handoff/wbs-realtime-review.md`), and the Syrinx transport seam (`packages/ws`,
> `packages/realtime`, `packages/server-workers`).

## Decision: **hybrid-optional-adapter** (build-and-learn; optional opt-in adapter, gated on a spike)

Judges: architecture-lockin → hybrid; dx-ecosystem → hybrid; workers-bundle-edge → build-and-learn (same
posture via the bundle lens). **Do NOT make `@openai/agents/realtime` the default front.**

### The decisive finding
Their `RealtimeSession` normalizes events in `OpenAIRealtimeBase.parseRealtimeEvent` against OpenAI's
`realtimeServerEventSchema`, and **every** transport (`OpenAIRealtimeWebSocket`, `OpenAIRealtimeWebRTC`,
`CloudflareRealtimeTransportLayer`, Twilio/SIP) extends that base. So a Grok/Gemini/Moshi front means
writing a from-scratch `RealtimeTransportLayer` emitting **OpenAI-shaped** events — the exact translation
`fromOpenAIRealtime` already does, except we'd swap a schema **we own** for one **OpenAI controls**, and
drag the full `openai ^6.35` SDK + a hard `zod 4` peer + `ws` into a provider-neutral, self-hostable core.

- Their headline edge feature (Cloudflare `fetch()`-upgrade + skip-open) is **functionally equivalent to
  what we already ship** (`packages/ws/src/workers.ts` + `web-socket.ts:57-64`), and ours generalizes to
  any auth-header provider (Deepgram/Cartesia). Validated, not adopted.
- **Bundle:** `@openai/agents-extensions` → `@openai/agents-core` → `openai` SDK + `zod 4` + `ws`. The
  Mastra-edge worker is already ~8 MB near the Free 8 MB cap; this is strictly additive → likely pushes
  edge deploy to a paid plan. Net loss on the workers lens.
- Adopting-default surrenders the bi-model + provider-neutral moat for a DX win that **only** helps the
  single-model OpenAI case. Steal the ideas, not the architecture.

## Keep vs adopt
- **KEEP unchanged:** `RealtimeAdapter`/`RealtimeEvent` (the schema we own), `PipelineBus`+`RealtimeBridge`+
  bi-model Reasoner seam, `packages/ws` factories (`createWorkersSocket`/`createWebSocketAdapter`/
  `WebSocketConnection` with reconnect/replay/quick-failure — richer than their transports), carrier
  adapters, R2 recorder, resumable WS protocol. **Do NOT replace `createWorkersSocket`** with their
  OpenAI-socket-only Cloudflare transport.
- **ADOPT (by copying shapes, dependency-free):** their high-value event vocabulary — see backlog.
- **OPTIONAL, opt-in only:** a `fromOpenAIAgentsTransport` adapter wrapping a `RealtimeTransportLayer`, in a
  **separate package/entry** with `openai`/`zod 4`/`ws` as `optionalDependencies` — never in core, never
  default. Ships only if the spike (below) proves the deps stay quarantined.
- **REJECT:** `openai` SDK + `zod 4` in the core dependency graph.

## "Learn from their transport" backlog (each dependency-free; only land with a concrete bus/bridge consumer)
- **T-01** symmetric `audio_interrupted` event (distinct from `speech_started`; today interrupt is one-way).
- **T-02** typed turn lifecycle (`responseId` on `response_started/_done`) + `usage_update`; removes the
  synthesized `randomUUID` contextId — **also kills the `node:crypto` import (folds into R-04)**.
- **T-03** `sendMessage(text)` (inject a text turn without audio).
- **T-04** `mute()/muted`.
- **T-05** negotiated audio format (caps-driven, replace hardcoded 24 kHz).
- **T-06** ephemeral client-secret auth path (for future browser→provider edge topologies).
- **T-07** document + test the workerd skip-open detail (folds into review R-05).
- **T-08** (defer) `addImage`/`resetHistory`/MCP-approval — no consumer yet.

## Reconcile with the codex review (NOT-READY)
Adoption would **not** moot the Workers rows — the Node primitives live in *our* bridge/mapping code, and
the live edge path is the **cascade** (`live-session.ts`), not `RealtimeBridge`. The decision **reinforces**:
- **R-04** (remove `Buffer`/`node:crypto`/`process` from `packages/realtime`) — required, reprioritized **up**;
  edge-safe replacements already exist in-repo (`decodeBase64`/`atob` in `edge.ts`, `crypto.randomUUID()` in
  `worker.ts`). **Sequence T-02 with R-04.** ~half-day. This is what makes the bi-model front edge-clean.
- **R-05** (document+test the Cloudflare wiring we keep) — required; folds with **T-07**.
- **R-14** (no-`Buffer`/no-`process` workerd CI build, no `nodejs_compat`) — required, reprioritized **up**;
  `nodejs_compat` currently *masks* R-04.

## The one thing to validate first — dependency-isolation spike (≤ half-day)
Before writing the optional adapter: scaffold a throwaway package importing `@openai/agents/realtime` +
`@openai/agents-extensions`; **measure installed-tree + workerd bundle delta**; verify core stays free of
`openai`/`zod`. PASS → ship the optional adapter; FAIL → hybrid degrades to "event-shapes only" (still correct).

## Sequencing
R-04 + T-02 (edge-clean the bridge) → R-14 (CI gate) → R-05 + T-07 (document the wiring we keep) → spike →
optional `fromOpenAIAgentsTransport` only if PASS. Event-shape items (T-01/T-03/T-04/T-05) in parallel, each
gated on a named consumer.
