# Understanding — AISDKBridgePlugin re-home onto `Reasoner` (Sprint 1)

> Author: claude-opus-4-8[1m] · manager · 2026-06-05. Grounded in a full read of `packages/voice-bridge-aisdk/src/index.ts` (1–491), `index.test.ts` (the 9 tests), `from-ai-sdk.ts`, and the 4 production/example call sites. Confidence: **high** (every claim has a file:line anchor).

## Primitive (one line)

The bridge is a `VoicePlugin` that, on each `eos.turn_complete`, drives **one cancellable streaming generation** and reduces its parts to `llm.*` bus packets — while owning conversation **history** as the single source of truth for barge-in. Sprint 1 replaces the *generation mechanism* (`streamResponse`/`fullStream`) with `reasoner.stream(turn)` **without changing any of the surrounding behavior**.

## Map at a glance

- The bridge has **two seams today**: an injected `streamFactory` (test seam, `index.ts:77`) and a default `createOpenAI`/`streamText` path (`index.ts:270`). The Reasoner re-home unifies both *behind* `Reasoner` — `fromStreamFactory` wraps the former (B2), `fromAiSdkAgent`/`fromStreamText` wrap the latter (B3).
- The only loop that changes is `processTurn`'s `for await (part of withStreamIdleTimeout(this.streamResponse(...)))` + 10-case `TextStreamPart` switch (`index.ts:167–211`) → `for await (part of withStreamIdleTimeout(this.reasoner.stream(turn)))` + **6-case `ReasoningPart` switch**.
- **Everything else is verbatim:** retry loop (`:163,228–253`), finish-reason validation (now consumed via the `finish`/`error` parts), turn-superseding (`:153`), `interrupt.llm` handler + spoken-prefix barge-in (`:135,329–375`), history ownership (`:317,377`), idle-timeout wrapper (`:445`).
- **Config splits** in S1-02: provider config (`api_key`/`model`/`system_prompt`/`tools`/`tool_choice`/`temperature`/`max_output_tokens`/`max_steps`) moves to the **adapter at the call site**; bridge config (`timeout_ms`/`max_history_turns`/retry) **stays** in `initialize`.
- **9 tests stay byte-for-byte** on assertions; each construction line `new AISDKBridgePlugin(fn)` → `new ReasoningBridge(fromStreamFactory(fn))` (B2). The tests pass a factory, so the config split doesn't touch them (their `api_key`/`model` config becomes inert, as it already is whenever a factory is present — `streamResponse` short-circuits on `this.streamFactory`, `index.ts:265`).

## Top-down ↔ bottom-up

**Top-down (call site → plugin):** `VoiceAgentSession.registerPlugin("bridge", plugin)` → `plugin.initialize(bus, pluginConfig.bridge)` → the plugin subscribes to `eos.turn_complete` (`index.ts:101`). All 4 non-test sites construct `new AISDKBridgePlugin()` **with no argument**:
- `packages/voice-server-workers/src/live-session.ts:80` (prod worker) — `openaiKey`/`model`/`system_prompt` are in scope at `:62–65`.
- `examples/02-hello-voice-headless/src/run-one-turn.ts:217` — `pluginConfig.bridge` built from `process.env`.
- `examples/02-hello-voice-headless/src/university-support-agent.ts:112`.
- `examples/02-hello-voice-headless/scripts/run-university-support-baseline.ts:227`.

**Bottom-up (the part switch → bus packets):** `processTurn` consumes parts and pushes `llm.delta` (`:173`), `llm.tool_call` (`:180`), `llm.tool_result` (`:189`), then on normal stop `llm.done` (`:219`) + `rememberTurn` (`:225`); on a thrown/abnormal part it routes to the **retry/`llm.error`** path (`:228–253`). The 9 tests assert exactly these packets + the barge-in history rewrites.

**Agreement:** both views converge on — the bridge is a *pure function of the turn* except for `history` and `activeGeneration`. The Reasoner takes over generation; the bridge keeps the rest.

## The 6-case `ReasoningPart` switch (replaces `index.ts:169–210`)

| `ReasoningPart` | Bridge action (must equal today) | Today's equivalent |
|---|---|---|
| `text-delta` | `reply += text`; `emittedDelta = true`; push `llm.delta` | `:169–178` |
| `tool-call` | push `llm.tool_call` (`toolId`→`toolId`, `toolName`, `toolArgs: args`) | `:179–187` |
| `tool-result` | push `llm.tool_result` (`result`) | `:188–196` |
| `error` | **throw** into the existing catch → retry or `llm.error` (use `part.cause`; `part.recoverable` mirrors `categorizeLlmError`) | `:197–200` (today throws on `error`/`tool-error`) |
| `finish` | `reason==="length"` → throw "token limit" (→ `llm.error`); `reason==="stop"|"tool"` → push `llm.done(text)` + `rememberTurn` | `:206–210` + `validateFinalFinishReason` `:397` |
| `suspended` | **Sprint 3** — not wired in Sprint 1 (no AI SDK backend emits it; adapter never produces it) | — |

**Critical preservation rules (from §4.5 + the tests):**
1. **Signal-abort ≠ `error` part.** Every iteration still begins with `if (signal.aborted) return;` (`:168`) — a barge-in is a *silent return*, never an `llm.error`. The adapter maps an `abort` *stream-part* to `error`, but `signal.aborted` (the interrupt handler aborting `activeGeneration`, `:138`) must still short-circuit silently. Do **not** let an `error` part fire when the cause is our own abort.
2. **`finish(length)` → error.** The Sprint-0 adapter emits `finish:length` as a `finish` part (not `error`); the bridge `finish` case must reject it to preserve the "token limit → llm.error" test (`index.test.ts:70`). This is the PLAN §6 decision's consumer side.
3. **No-finish → error.** The adapter already emits a terminal `error("…ended without a provider finish reason")` when the stream ends without `finish` — preserving `index.test.ts:98`. The bridge's `error` case routes it to `llm.error` (matching `validateFinalFinishReason` null-check, `:398`).
4. **`emittedDelta` gating retry** (`:232`): once a delta emitted, an error is non-retryable (can't replay a partial spoken reply). Keep this exact gate.
5. **`rememberTurn` only on committed `llm.done`** (`:225`); barge-in path owns history via `commitInterruptedHistory` (`:349`).

## `ReasonerTurn` construction (the bridge builds it each turn)

`reasoner.stream({ userText, messages: <history as ReasonerMessage[]>, signal })`. Today `streamResponse` builds `messages = [...this.history, {role:"user",content:userText}]` (`index.ts:264`) and the adapter appends the user message — so the **bridge passes `this.history` as `messages` and `userText` separately**; the adapter (`from-ai-sdk.ts:91`) does the append. History stays `ReasonerMessage[]`-shaped (role+content) — already compatible with the bridge's `{role,content}` history objects.

## Config split (S1-02 — the non-mechanical part)

| Config key (today read in `initialize`, `:81–91`) | After re-home |
|---|---|
| `api_key`, `model`, `system_prompt`, `tools`, `tool_choice`, `temperature`, `max_output_tokens`, `max_steps` | **Move to the adapter** — passed to `fromStreamText(config)` / baked into the `fromAiSdkAgent` agent at the call site |
| `timeout_ms` | **Dual:** the bridge keeps it for `withStreamIdleTimeout` (`:167`); the adapter also uses it for streamText `timeout` (`:281`) |
| `max_history_turns`, retry (`readRetryConfig`) | **Stay** bridge-level |

**Call-site migration (S1-02):** each `new AISDKBridgePlugin()` → `new ReasoningBridge(fromStreamText({ model: createOpenAI({apiKey})(model), system, temperature, maxOutputTokens, maxRetries: 0, timeout, stopWhen: stepCountIs(maxSteps), tools, toolChoice }))`. **`maxRetries: 0` is mandatory** (today's bridge sets it, `:279`; KI-0-02). The keys are in scope at every call site (`live-session.ts:63` has `openaiKey`; examples read `process.env`).

## Key files (ranked)

| File | Role | Confidence |
|------|------|------------|
| `packages/voice-bridge-aisdk/src/index.ts` | the plugin being re-homed (S1-01 + S1-02) | high |
| `packages/voice-bridge-aisdk/src/index.test.ts` | the 9 zero-drift assertions (construction line adapts only) | high |
| `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` | the Reasoner the bridge will be driven by | high |
| `packages/voice-server-workers/src/live-session.ts` | prod call site (S1-02 + S1-03 deploy) | high |
| `examples/02-hello-voice-headless/src/run-one-turn.ts` | the `smoke:websocket-interactive` latency harness path (S1-00) | high |
| `packages/voice/src/reasoner.ts` | the seam contract | high |

## Invariants (must not drift)

- **Concurrent EOS handler** (`{concurrent:true}`, `:104`) + supersede-by-abort (`:153`): a new turn aborts the prior `activeGeneration`. Keep.
- **History = single source of truth for "what was said"** (§4.5); the backend is stateless-per-turn.
- **No buffering** (`reasoner.stream` yields immediately — already guaranteed by the Sprint-0 adapter).
- **Barge-in precision ladder** (word-timestamps+playout → exact; else text-sent-to-TTS), `computeSpokenPrefix` `:329`. Untouched — it lives entirely in the bridge.
- **finish-reason metrics** (`recordFinishReason`, `:290`): today emitted from `finish-step`/`finish`. The `ReasoningPart` union does **not** carry `finishReason` metric strings → see open question OQ-1.

## Coupling hotspots

- `withStreamIdleTimeout`/`nextWithTimeout` (`:445–490`) wraps the generator and calls `stream.return()` on timeout/abort. It must wrap `reasoner.stream(turn)` (an `AsyncIterable`, not `AsyncGenerator`) — confirm `.return()` semantics still hold, or adapt the wrapper to `AsyncIterable`. **Medium risk.**
- The `interrupt.llm` handler aborts `activeGeneration.controller` (`:138`); the `turn.signal` passed to `reasoner.stream` must be that same controller's signal so the adapter forwards the abort into the backend. Wire `turn.signal = controller.signal`.

## Open questions

- **OQ-1 (minor):** today the bridge emits `llm.finish_step_reason` / `llm.finish_reason` metrics from the raw `finish-step`/`finish` parts (`:202,:209`). `ReasoningPart.finish` carries only `reason: stop|tool|length` (no `rawFinishReason`). Is the metric still required after re-home? The 9 tests assert `llm.finish_reason value:"stop"` (`index.test.ts:59`). **Resolution path:** the bridge's `finish` case must still emit `llm.finish_reason` with the mapped reason to keep that test green — so the `finish` part's `reason` is sufficient for the `stop` case; the `rawFinishReason` detail is lost but no test asserts it. Confirm at S1-01.
- **OQ-2 (minor):** `withStreamIdleTimeout` typing — `AsyncGenerator` vs `AsyncIterable`. Resolve by typing the wrapper to `AsyncIterable<ReasoningPart>` and obtaining the iterator explicitly. <15 min at S1-01.

## Suggested next command

implement → brief S1-00 (latency baseline) first, then S1-01 (drive bridge from Reasoner, this map is the contract), then S1-02 (rename + config split + call-site migration), then S1-03 (edge + deploy + latency gate). Link this artifact in each brief's Read-These-First.
