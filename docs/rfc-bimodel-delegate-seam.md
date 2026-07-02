# RFC: The bi-model delegate seam — result envelope, observability, preamble lifecycle, durable resume, and packaging the Responder-Thinker

> Status: **Draft** (2026-07-02). Author: research-led. Grounded in a live-consumer review
> (`SESSION-HANDOFF-syrinx-core-roadmap.md` §2 — the SLIIT chatbot's hand-rolled workarounds) cross-checked
> against a competitive teardown of Pipecat, LiveKit Agents, Vapi/Retell/Bland, and the provider realtime
> SDKs (OpenAI Realtime + Agents SDK, Deepgram Voice Agent, ElevenLabs, Gemini Live) — same doc §3.
> Builds on: `docs/rfc-realtime-bridge.md` (the `RealtimeBridge`), `docs/rfc-reasoner-bridge.md` (the
> `Reasoner` seam), `packages/core/src/reasoner.ts`.

## 1. Context & problem

Syrinx's differentiation is the **bi-model / Responder-Thinker** shape: a fast realtime speech model in
front, an async reasoning/RAG model (`Reasoner`) behind, delegated to via one tool
(`consult_knowledge`-style). The competitive research settled a sharp finding:

> **Nobody packages the bi-model architecture turnkey.** Pipecat has only primitives
> (`ParallelPipeline`/`ServiceSwitcher`/`WorkerBus`); LiveKit does it manually (tool-call-out / `llm_node`);
> the commercial API products (Vapi/Retell/Bland) only *approximate* it by binding filler speech to a
> blocking tool; OpenAI *documents* the Responder-Thinker pattern (Realtime Prompting Guide) and the Agents
> SDK implements "Delegation through tools" (`backgroundResult()`), but ships no product.

Syrinx's `RealtimeBridge` + `Reasoner` **is** this architecture — but the delegate seam is unfinished, so
the only live consumer (SLIIT) had to hand-roll four workarounds around it (`SESSION-HANDOFF` §2, items
1/2/4/6). This RFC closes those four seams and, in doing so, makes the bi-model pattern the **named,
first-class primitive** the field is missing. Two of the four are genuine differentiation (the OSS leaders
leave them open); two are catch-up to table-stakes done cheaply by mirroring the field.

## 2. Goals / non-goals

**Goals**
- **G1 (result envelope).** A first-class way for the `Reasoner` result to reach the front model as a
  structured, authoritative JSON envelope so the model stops paraphrasing/inventing — replacing the
  per-consumer hand-wrap. *(Differentiation: OSS stringifies; only OpenAI documents an envelope.)*
- **G2 (observability).** The bridge emits delegate lifecycle events (`delegate.query`/`delegate.result`)
  on the bus so consumers stop wrapping the `Reasoner` just to log/persist. *(Table-stakes: universal.)*
- **G3 (preamble/filler lifecycle).** A typed tool-call filler lifecycle (start / still-working / complete
  / failed) surfaced as a standard wire event, **decoupled from a blocking tool** so it masks the async
  reasoner latency — not just a single tool call. *(Differentiation: everyone binds filler to a blocking tool.)*
- **G4 (durable resume).** Durable conversation state for the reasoner across DO eviction/reconnect, and one
  `resume(history)` that replays on providers without native resume and passes the handle through on Gemini.
  *(Differentiation: OSS is ephemeral; only Gemini has native resume.)*
- **G5 (packaging).** Compose G1–G4 into the RealtimeBridge as the documented Responder-Thinker primitive,
  so a new consumer wires a front + a `Reasoner` and gets envelope + observability + preamble + resume for free.

**Non-goals**
- Reusable prompt fragments (`SESSION-HANDOFF` §2 item 3) — a separate optional `@kuralle-syrinx/prompts`
  package, not this RFC.
- The telephony turn-detection preset (item 5) — a separate small ergonomic change.
- Changing the `Reasoner` interface's latency invariant (§7a of the reasoner RFC) — the envelope is applied
  at the bridge boundary, not by buffering inside the seam (see R2).
- Cross-*call* long-term memory (Mem0-style) — out of scope; this is per-conversation durable state.

## 3. Prior art (grounding — read before designing)

- **`packages/core/src/reasoner.ts`** — the seam. `Reasoner.stream(turn) → AsyncIterable<ReasoningPart>`;
  `ReasoningPart ∈ {text-delta, tool-call, tool-result, suspended, error, finish}`. The envelope must sit at
  the bridge's delegate boundary, not mutate this stream.
- **SLIIT hand-rolls (the exact gaps):** `…/sliit-chatbot/apps/api/src/voice/reasoner.ts:96` wraps the
  answer in `{ response_text, render:"translate_faithfully" }`; `:74,83` console.logs the query + answer;
  `sliit-voice.ts:188` sends an app-invented `{type:'thinking'}`; module-global `MemoryStore` + constant
  `userId`.
- **OpenAI Realtime Prompting Guide — "Tool Output Formatting"** (the canonical envelope). Wrap output as
  JSON (`response_text` + flags like `require_repeat_verbatim`) so the model treats it as authoritative;
  a raw string + "repeat exactly" instruction is more prone to paraphrase/truncate. → this is the shape for G1.
- **Vapi typed filler lifecycle** — `request-start` / `request-response-delayed` (+`timingMilliseconds`) /
  `request-complete` / `request-failed`. → the shape for G3. ElevenLabs adds a built-in earcon (Tool Call
  Sounds) + slow-LLM Soft timeout; Deepgram: *"prompt as policy, server code as enforcement"* (Syrinx's
  deterministic `onToolCallStart` already matches this).
- **Session resume** — Gemini Live `sessionResumption` (handle + `goAway`); OpenAI/Deepgram/ElevenLabs
  require client replay of transcript + function-call log. → the shape for G4.
- **Pipecat / LiveKit observability** — OTel spans with `tool.arguments`/`tool.result`; per-tool
  `agent_tool_start`/`agent_tool_end`. → the shape for G2.

## 4. Proposed design (summary)

Four composable additions at the bridge/reasoner boundary; the `Reasoner` interface is unchanged.

```
front tool_call ─► RealtimeBridge.runDelegate
     │  G2: emit delegate.query{query, contextId}
     ├─ G3: emit tool_call_started (typed preamble lifecycle) → client cue + provider filler
     ├─ reasoner.stream(turn)  ── unchanged seam (§7a latency invariant preserved)
     │  G2: emit delegate.result{answer, ms, grounded}
     ├─ G1: wrap final answer in the structured envelope (require_repeat_verbatim)
     └─ injectToolResult(envelope) ─► front voices it faithfully
G4: reasoner session state persisted to DO SQLite; resume(history) on reconnect
```

**G1 — structured result envelope.** A bridge option `toolResultFormat: "string" | "envelope"` (default
`"envelope"` for realtime delegate turns). When `"envelope"`, the bridge wraps the accumulated reasoner
answer as `{ response_text, format, require_repeat_verbatim }` before `injectToolResult`. Optional
`renderDirective` (e.g. `"translate_faithfully"`) is passed through from the reasoner's `finish`/last part
metadata or a bridge option. Consumers stop hand-wrapping; the SLIIT `reasoner.ts` custom `.stream()` becomes
deletable.

```ts
interface DelegateResultEnvelope {
  readonly response_text: string;        // the authoritative answer
  readonly require_repeat_verbatim?: boolean; // default true for facts
  readonly format?: "plain" | "markdown";
  readonly render?: string;              // optional app directive, e.g. "translate_faithfully"
}
```

**G2 — delegate observability.** New Background-route packets, emitted by the bridge's delegate loop:
```ts
| { readonly kind: "delegate.query";  readonly contextId: string; readonly timestampMs: number; readonly query: string; readonly toolName: string }
| { readonly kind: "delegate.result"; readonly contextId: string; readonly timestampMs: number; readonly answer: string; readonly durationMs: number; readonly grounded: boolean }
```
Emitted around `reasoner.stream(...)` (query before, result after). Optional OTel span mirrors Pipecat/LiveKit
(`tool.arguments`/`tool.result`). Consumers subscribe for logging/persistence instead of wrapping the Reasoner.

**G3 — preamble/filler lifecycle.** A typed server event (surfaced by `@kuralle-syrinx/browser-client` as a
client event, replacing SLIIT's ad-hoc `{type:'thinking'}`):
```ts
type ToolCallCue =
  | { type: "tool_call_started";  contextId: string; toolName: string }
  | { type: "tool_call_delayed";  contextId: string; afterMs: number }   // time-triggered "still working"
  | { type: "tool_call_complete"; contextId: string }
  | { type: "tool_call_failed";   contextId: string };
```
`onToolCallStart` (v3.1.0) fires `tool_call_started` deterministically before the reasoner runs;
`tool_call_delayed` fires from a bridge timer if the reasoner exceeds `delayCueAfterMs`; complete/failed on
the delegate's terminal part. **Decoupled from a blocking tool** — it wraps the reasoner-latency window, which
is the bi-model gap the field leaves open.

**G4 — durable reasoner session + resume.** A `ReasonerSessionStore` seam backed by DO SQLite (Node impl =
in-memory) so the reasoner's conversation state survives DO eviction/hibernation instead of a module-global
`MemoryStore`. `withVoice` gains `resume(history)`: on reconnect it re-seeds the reasoner from durable
history, and (realtime front) replays transcript + function-call log on OpenAI/Deepgram/ElevenLabs or passes
the `sessionResumption` handle through on Gemini.

**G5 — packaging.** The above are wired into `RealtimeBridge` behind `withVoice(Agent, { … })` options so a
new consumer gets the Responder-Thinker primitive turnkey; documented in a `packages/realtime/README` section
+ the building-a-voice-agent guide.

## 5. Hard requirements (non-negotiable correctness)

- **R1 (unchanged Reasoner seam).** `Reasoner.stream` and `ReasoningPart` are not changed. The envelope is
  applied by the bridge to the *accumulated delegate answer* at `injectToolResult` time (the bridge already
  buffers the delegate stream into one tool result — RFC-realtime §4), so G1 adds no latency.
- **R2 (latency invariant preserved).** The reasoner RFC §7a invariant holds: no buffering added on the
  cascade `text-delta` path. G1's envelope only wraps the *delegate* (realtime tool-result) path, which is
  already a single buffered tool result — byte-for-byte latency-neutral (assert with the existing gate).
- **R3 (backward-compatible default, opt-out).** `toolResultFormat` defaults to `"envelope"` for realtime
  delegate turns but a consumer can set `"string"` for the pre-RFC behavior. Cascade turns are unaffected.
- **R4 (observability is Background-route, side-effect-free).** `delegate.query`/`delegate.result` are
  `Route.Background` (droppable), never block the hot path, and carry no PII beyond the query/answer the
  consumer already handles.
- **R5 (barge-in unaffected).** G3's cues and G4's resume never interfere with the barge-in path
  (`interrupt.tts` → cancel + truncate); `tool_call_failed` fires on delegate abort.
- **R6 (durable state correctness).** `resume(history)` produces a reasoner whose next turn sees the same
  context as before the drop; a resumed session must not double-answer or lose the in-flight turn. Gemini
  handle passthrough must not replay (it resumes server-side).

## 6. Out of scope / explicitly NOT touched

The `Reasoner` interface; the cascade STT/LLM/TTS plugins; the transport; barge-in/truncation; the prompt
fragments package (item 3); the telephony turn preset (item 5); cross-call long-term memory.

## 7. Risks & open questions (resolve in build)

- **OQ1 (envelope field names).** Adopt OpenAI's `require_repeat_verbatim` verbatim, or a Syrinx-neutral
  name? Default: mirror OpenAI's documented names since they're the only validated shape and gpt-realtime is
  the primary front.
- **OQ2 (render directive source).** Does `render` come from a bridge option, or can the reasoner attach it
  to its `finish` part? Start with a bridge option; add reasoner-attached metadata only if a consumer needs
  per-turn directives.
- **OQ3 (DO SQLite reasoner store shape).** How much reasoner state is durable vs re-derivable — full message
  history, or a compacted summary? Measure size; start with bounded recent history + summary.
- **R-risk (Gemini resume asymmetry).** Gemini resumes server-side while others replay; `resume()` must not
  double-apply. Gate with a per-provider capability flag (`supportsNativeResume`).

## 8. Work breakdown (build order — each gated)

Sequential; each chunk green (`pnpm -r typecheck` + `pnpm -r test`) before the next.

- **WBS-1 — G2 observability (the cheap table-stakes win, do first).** Add `delegate.query`/`delegate.result`
  packet kinds (`packages/core/src/packets.ts`); emit them in the RealtimeBridge delegate loop
  (`packages/realtime/src/realtime-bridge.ts` `runDelegate`) and, for cascade, the ReasoningBridge
  (`packages/aisdk`). Test: a delegate turn emits query-then-result with the right fields. **DoD:** the SLIIT
  `reasoner.ts` console.log wrapper is provably deletable (a consumer can subscribe instead).
- **WBS-2 — G1 result envelope.** `toolResultFormat` option + `DelegateResultEnvelope` wrap at
  `injectToolResult`. Test: envelope shape + `require_repeat_verbatim`; `"string"` opt-out unchanged; latency
  gate (no regression, per R2). **DoD:** SLIIT's hand-wrap is deletable.
- **WBS-3 — G3 preamble lifecycle.** Typed `ToolCallCue` server events; `onToolCallStart` → `tool_call_started`;
  bridge timer → `tool_call_delayed`; browser-client surfaces them as client events. Test: cues fire on
  start/delay/complete/fail; barge-in unaffected. **DoD:** SLIIT's `{type:'thinking'}` is replaceable by the
  standard event.
- **WBS-4 — G4 durable reasoner session + resume.** `ReasonerSessionStore` seam (DO-SQLite impl in cf-agents,
  in-memory in core); `withVoice` `resume(history)`; per-provider `supportsNativeResume`. Test: reconnect
  re-seeds context; Gemini passthrough doesn't replay; no double-answer. **DoD:** SLIIT can drop the
  module-global `MemoryStore`.
- **WBS-5 — G5 packaging + docs.** Wire G1–G4 into `withVoice` options; README + building-a-voice-agent guide
  section naming the Responder-Thinker primitive. **DoD:** a fresh consumer gets envelope+observability+preamble+
  resume by wiring a front + a Reasoner; the SLIIT integration is simplified end-to-end (measure LOC removed).

## 9. Verification ladder (done = all)

1. `pnpm -r typecheck` + `pnpm -r test` green across the workspace.
2. WBS-1…4 gates passed; each proves the corresponding SLIIT hack is deletable.
3. Latency gate unchanged (R2) — the envelope adds no measurable v2v delta.
4. A live bi-model smoke: front delegates → observability events fire → envelope voiced faithfully → a
   simulated reconnect resumes context (observed end-to-end per CONTRIBUTING's bar, not assumed).
5. The SLIIT `reasoner.ts`/`sliit-voice.ts`/`voice-client.ts` workarounds are removed against the new core and
   the app still passes its evals (the real acceptance test — the consumer stops fighting the engine).
