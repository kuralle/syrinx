# RFC: RealtimeBridge — bi-model voice (gpt-realtime-2 front + Reasoner "meat" back)

> **Status:** Draft → Ready-for-build · **Branch:** `v2` · **Owner:** manager (octalpixel) · **Date:** 2026-06-06
> **Backlog ID:** B-01 (`docs/rfc-reasoner-bridge.md` §9.1: "Realtime / S2S `RealtimeBridge` (sibling `VoicePlugin`)")
> **Design of record this refines:** [`rfc-reasoner-bridge.md`](./rfc-reasoner-bridge.md) (v2.3) — the `Reasoner` seam.
> **Research + rationale:** [`../bi-model-research/README.md`](../bi-model-research/README.md) · **Blueprint:** [`../bi-model-research/blueprint.md`](../bi-model-research/blueprint.md)

This RFC is the build contract. Section 8 (WBS) is the **delegation plan** — each row is one handoff to an
IC (cursor). ICs implement to the letter of the row's *Scope / Read-first / Interface / DoD /
Acceptance / Out-of-scope*; deviations require manager sign-off, not IC discretion.

---

## 1. Context & problem

Syrinx today is a **cascade**: transport → `user.audio_received` → STT → `ReasoningBridge(Reasoner)` →
TTS → `tts.audio`. The frontier of production voice (Intercom Fin Voice 2, Kyutai MoshiRAG, Thinking
Machines Interaction Models) has moved to a **bi-model** shape: a fast, always-present **realtime/s2s
FRONT model** owns live presence + speech understanding + turn-taking; a heavier **async BACK model**
owns the "meat" (RAG/reasoning/tools); back results are injected into the live stream, hidden under the
natural lead-in gap so perceived latency stays ~0. (Full analysis: `bi-model-research/README.md` §1–§3.)

We want this in Syrinx **without rewriting the kernel**. The `Reasoner` seam already anticipated it
(`rfc-reasoner-bridge.md:50,304`: "a `Reasoner` plugs into it later as a **delegate tool** — no change to
this seam"). The first primitive is **OpenAI `gpt-realtime-2`** as the FRONT and **the existing
university support agent** (the `.stream` we proved live on 2026-06-06 via
`examples/02-hello-voice-headless` `smoke:university-support`) as the BACK Reasoner.

## 2. Goals / non-goals

**Goals**
- G1. A `RealtimeBridge` `VoicePlugin` (sibling to `ReasoningBridge`) that owns a full-duplex
  `gpt-realtime-2` WebSocket session and bridges it onto the existing `PipelineBus` vocabulary
  (`user.audio_received` in; `tts.audio`/`tts.end` out), with **no kernel change**.
- G2. The **existing `Reasoner` seam reused verbatim** as the async "meat" back end, invoked as a
  delegate tool. First back end = the **university support agent** wrapped via `fromStreamText(...)`.
- G3. Front→back handoff over existing `llm.tool_call`/`llm.tool_result` packets (the `<ret>` analog).
- G4. Correct barge-in, correct multi-turn (no permanent mute), provider-rate↔engine-rate audio, and a
  **live end-to-end proof** (the university late-add turn, voiced by gpt-realtime-2 with the grounded
  answer) within the ~800 ms–1 s budget for first audio.

**Non-goals**
- No model finetuning / embedding-sum injection (that's the owned-Moshi path; out of scope here).
- No new transport, no WebRTC, no telephony-specific work (browser `/ws` path is the target; telephony
  reuse falls out for free but is not gated here).
- No Gemini Live / Moshi adapters in this RFC (only capability hooks so they can follow later).
- No replacement of the cascade — `RealtimeBridge` is an alternative plugin, selected at session config.

## 3. Prior art (grounding — read before designing)

- `bi-model-research/README.md` §3 — the injection fork (closed API ⇒ token/context-layer, not embeddings).
- `bi-model-research/blueprint.md` — interfaces, delegate loop, contextId lifecycle, build order.
- `docs/rfc-reasoner-bridge.md:50,304,321` — B-01 framing; the `Reasoner` seam is unchanged.
- `packages/aisdk` — `ReasoningBridge.processTurn` is the loop to mirror for the delegate; `fromStreamText`
  is the Reasoner factory we reuse for the university agent.
- OpenAI Realtime API (verified live 2026-06-06): model `gpt-realtime-2`; `session.update`; audio
  `audio/pcm` @ 24000 Hz; `semantic_vad`; client `input_audio_buffer.append` / `conversation.item.create`
  (`function_call_output`) / `response.create` / `response.cancel` / `conversation.item.truncate`; server
  `input_audio_buffer.speech_started|stopped` / `response.output_audio.delta|done` /
  `response.output_audio_transcript.delta|done` / `response.function_call_arguments.delta` / `response.done`.

## 4. Proposed design (summary)

```
user.audio_received ─► RealtimeBridge ─► (resample 16k→24k) ─► gpt-realtime-2 WS  ──┐
gpt-realtime-2 WS ─► (resample 24k→16k, chunk ≤20ms) ─► tts.audio ─► edge ─► client │ live loop
gpt-realtime-2 tool_call "ask_university" ─► reasoner.stream(turn) [university agent] │ delegate (async, off hot path)
reasoner result ─► function_call_output ─► gpt-realtime-2 voices the grounded answer  ┘
```

- **FRONT:** `RealtimeBridge` (new `@kuralle-syrinx/realtime`) + a duplex realtime socket in `packages/ws`.
- **BACK:** `fromStreamText({ model: openai("gpt-4.1-mini"), system: UNIVERSITY_SUPPORT_PROMPT, tools:{resolveLateAddRequest} })`
  — literally the agent from `scripts/run-university-support-baseline.ts`, passed as the `Reasoner`.
- **Handoff:** gpt-realtime-2 is given one tool (`ask_university`); on its `function_call`, the bridge runs
  the Reasoner and returns the text via `function_call_output`.

Detailed interfaces, the delegate loop, the per-turn `contextId` lifecycle, and the honest timing model
are in `bi-model-research/blueprint.md` §3–§6 — **that file is normative for this RFC**; ICs implement it.

## 5. Hard requirements (non-negotiable correctness — from adversarial review)

Every IC chunk that touches these MUST satisfy them; they are acceptance criteria, not nice-to-haves.

- **R1 (fresh contextId per turn).** Mint a new `contextId` on each `response.output_audio` turn start
  and emit a turn-boundary (`eos.turn_complete`) on `response.done`. A fixed `contextId` + no
  `eos.turn_complete` permanently mutes audio after the first barge-in. *(blueprint FIX A)*
- **R2 (audio rate).** Resample provider 24 kHz → engine 16 kHz on output (and chunk to ≤20 ms frames);
  resample engine 16 kHz → 24 kHz on input. The browser edge computes envelope duration at 16 kHz and the
  client rejects mismatched frames — unresampled 24 kHz audio is dropped client-side. *(FIX E/F)*
- **R3 (barge-in).** On provider `speech_started` → push `interrupt.detected`(Critical); on
  `interrupt.tts` → `response.cancel` **and** `conversation.item.truncate{item_id, audio_end_ms=playedMs}`
  **and** abort the in-flight delegate `AbortController`. Cancel alone desyncs server context. *(FIX D)*
- **R4 (full ReasoningPart contract).** The delegate loop handles `text-delta`, `finish` (carries
  `text`), `suspended` (terminal — reject, cannot voice inline), `error` — mirroring
  `ReasoningBridge.processTurn`. Not just `text-delta`. *(FIX H)*
- **R5 (packet shapes).** `llm.error` uses `{category: categorizeLlmError(cause), cause, isRecoverable}`;
  `stt.result`/`stt.interim` carry no invented `confidence`. No `as any` to bypass packet types. *(FIX, contracts)*
- **R6 (endpointing).** The session runs `endpointingOwner:"timer"`; no STT/VAD/EOS plugins on the live
  path. The s2s model owns turn detection. *(blueprint §7)*
- **R7 (honesty on latency).** No "~0 added latency" claims. The gate (WBS-5) measures the real delta
  (provider hop + 2 resamples) vs a direct gpt-realtime-2 baseline. *(FIX G)*

## 6. Out of scope / explicitly NOT touched

`packages/core` kernel logic; the cascade STT/TTS plugins; telephony adapters; the `Reasoner` seam
interface; any model finetuning; Gemini/Moshi adapters (only a `caps` flag is added for them).

## 7. Risks & open questions (resolve during build, not by guessing)

- OQ1 (async-fn-calling vs manual). With `gpt-realtime-2` native async function calling, does the model
  auto-continue after `function_call_output`, or must we still `response.create`? The guide says call
  `response.create`; async-calling may make that a double-response. **Resolve in WBS-4 via live smoke**;
  gate the adapter's `injectToolResult` behavior on the observed result. Default: send
  `function_call_output` then `response.create`; add a `caps.autoContinueOnToolOutput` escape hatch.
- OQ2 (`packages/ws` socket API). The current outbound socket serves cascade STT/TTS; the realtime duplex
  socket is new wiring. WBS-1 IC **must read the existing `packages/ws` module first** and reuse its
  connection/backpressure conventions rather than inventing a parallel client.
- R-risk: provider burst overrunning the 8 MiB outbound ceiling — mitigated by ≤20 ms chunking (R2).

---

## 8. Work breakdown (the delegation plan — build order)

Sequential; each chunk has a **gate** that must pass before the next is delegated. Worker = **cursor**
(per manager directive). Manager reviews the **git diff** of each before advancing (not the digest alone).
Each row is the literal brief contract for `/delegate --to cursor`.

> Convention for every chunk: TypeScript, ESM, vitest, match neighbour style; no kernel edits outside the
> named files; sentinel + green `pnpm -r typecheck` before "done"; cite the blueprint section implemented.

### WBS-1 — Realtime provider socket + `fromOpenAIRealtime` adapter
- **Scope (files):** `packages/realtime/` (new pkg: `package.json`, `tsconfig.json`, `src/realtime-adapter.ts`,
  `src/from-openai-realtime.ts`, `src/index.ts`); `packages/ws/src/realtime-socket.ts` (new duplex socket).
- **Read first:** `packages/ws/src/index.ts` (existing socket conventions), `bi-model-research/blueprint.md`
  §3.1 (the `RealtimeAdapter` interface + `RealtimeEvent` union), §5 (timing/caps), RFC §3 (event names).
- **Interface:** implement `RealtimeAdapter` exactly as blueprint §3.1. `caps` for gpt-realtime-2:
  `{inputSampleRateHz:24000, outputSampleRateHz:24000, supportsConcurrentToolAudio:true, supportsTruncate:true}`.
  Map provider events → normalized `RealtimeEvent`: `response.output_audio.delta`→`audio`,
  `input_audio_buffer.speech_started`→`speech_started`, `response.output_audio_transcript.*`→`transcript`,
  `response.done` function_call item→`tool_call`, response lifecycle→`response_started`/`response_done`,
  errors→`error`. `open()` sends `session.update` (model `gpt-realtime-2`, `audio.input/output` pcm@24000,
  `semantic_vad`, the `ask_university` tool, `output_modalities:["audio","text"]`). `sendAudio` →
  `input_audio_buffer.append` (base64). `cancelResponse(ms)` → `response.cancel` + `conversation.item.truncate`.
  `injectToolResult` → `conversation.item.create`(function_call_output) [+ `response.create` gated by caps].
- **DoD:** package builds; `OPENAI_API_KEY` read from repo-root `.env` (reuse `ensureRepoRootDotenv` pattern);
  unit test with a **mocked** WS asserting event mapping both directions; no live call in unit tests.
- **Acceptance (gate):** a `smoke:realtime-frame` script opens a real `gpt-realtime-2` session, sends one
  WAV fixture, captures one `audio` event, resamples 24k→16k, and **decodes it through
  `decodeSyrinxAudioEnvelope` without throwing** (proves R2). Manager runs this live.
- **Out of scope:** the bridge, the delegate, barge-in.

### WBS-2 — `RealtimeBridge` VoicePlugin: live audio loop (no delegate yet)
- **Scope:** `packages/realtime/src/realtime-bridge.ts`, `src/index.ts` (export).
- **Read first:** blueprint §3.2 + §6 (contextId lifecycle), `packages/aisdk/src/index.ts` (VoicePlugin
  shape, `initialize(bus,cfg)`), `packages/core/src/{packets,pipeline-bus}.ts` (exact packet kinds/Route),
  `packages/server-websocket/src/edge.ts` (how `tts.audio`/`user.audio_received` are wired).
- **Interface:** `class RealtimeBridge implements VoicePlugin` per blueprint §3.2. Consume
  `user.audio_received` → resample 16k→24k → `adapter.sendAudio`. Pump `adapter.events`:
  `response_started`→fresh `contextId` + `turn.change`; `audio`→resample 24k→16k + chunk ≤20 ms +
  `tts.audio`; `transcript(final)`→`stt.result`; `response_done`→`eos.turn_complete`+`tts.end`;
  `error`→`llm.error` (R5 shape). Run session with `endpointingOwner:"timer"` (R6).
- **DoD:** `pnpm -r typecheck` green; unit test driving a **fake adapter** that asserts: one turn produces
  `turn.change`→N×`tts.audio`(16k)→`eos.turn_complete`→`tts.end`, all sharing one fresh contextId.
- **Acceptance (gate):** live one-turn — speak a fixture WAV in, hear gpt-realtime-2 audio out end-to-end
  through the existing edge (reuse the headless harness shape). Observed, not assumed.
- **Out of scope:** barge-in, delegate.

### WBS-3 — Barge-in (detection + cancel + truncate + multi-turn)
- **Scope:** `packages/realtime/src/realtime-bridge.ts` (barge-in handlers), adapter `cancelResponse`.
- **Read first:** blueprint §6 (R1) + R3, `packages/core/src/voice-agent-session.ts`
  (`handleInterruptDetected`, `interruptedGenerationContextIds`, `handleTtsAudio` drop path),
  `packages/server-websocket/src/outbound-playout-pipeline.ts` (`clearInterruptible`).
- **Interface:** on `speech_started`→push `interrupt.detected`(Critical); subscribe `interrupt.tts`→
  `adapter.cancelResponse(playedMs)` (response.cancel + truncate) + abort delegate controller; track
  `playedMs` from `tts.playout_progress`.
- **DoD + Acceptance (gate):** **double-barge-in session test** — barge in twice on one session, assert the
  **second** turn's `tts.audio` is NOT dropped (proves R1). Plus a live barge-in: interrupt mid-answer,
  confirm audio stops promptly and the next turn is audible.
- **Out of scope:** delegate.

### WBS-4 — Delegate loop + university Reasoner wiring (the bi-model payoff)
- **Scope:** `packages/realtime/src/realtime-bridge.ts` (`runDelegate`); a new example/smoke
  `examples/02-hello-voice-headless/scripts/run-realtime-university.ts`.
- **Read first:** blueprint §4 (delegate loop), §5 (timing/caps), `packages/aisdk/src/index.ts`
  `processTurn` (the switch to mirror — R4), `examples/02-hello-voice-headless/scripts/run-university-support-baseline.ts`
  (the exact university agent + `resolveLateAddRequest` tool + prompt to reuse).
- **Interface:** `RealtimeBridge` takes `reasoner?: Reasoner` + `delegateToolName`. On `tool_call`
  matching the name: push `llm.tool_call`, run `reasoner.stream({userText, messages, signal})`, accumulate
  per R4, push `llm.tool_result`, `adapter.injectToolResult`. The smoke wires
  `new RealtimeBridge(fromOpenAIRealtime({...tool:"ask_university"...}), fromStreamText({UNIVERSITY_SUPPORT_PROMPT, tools:{resolveLateAddRequest}, model: openai("gpt-4.1-mini")}))`.
  **Resolve OQ1 here:** observe whether to `response.create` after `function_call_output`; set `caps` accordingly.
- **DoD:** fake-Reasoner unit tests for `finish`-with-text-no-deltas and `suspended` (R4); typecheck green.
- **Acceptance (gate):** live — the Maya-Chen late-add fixture turn: gpt-realtime-2 leads in, calls
  `ask_university`, the university Reasoner returns the Late-Add-Petition answer, gpt-realtime-2 **voices the
  grounded body** (mentions Late Add Petition + instructor/advisor/registrar). Transcript + audio captured.
- **Out of scope:** the latency report.

### WBS-5 — Latency gate + RealtimeBridge README
- **Scope:** `examples/.../scripts/run-realtime-latency.ts`; `packages/realtime/README.md`.
- **Read first:** `docs/latency-budget.md`, blueprint §9 row 5 (R7), `bi-model-research/README.md` §5.
- **Interface/DoD:** measure first-audio latency direct gpt-realtime-2 vs via-`RealtimeBridge`; report the
  delta; README documents config A, the `caps` model, and the honest latency characterization.
- **Acceptance (gate):** delta within budget OR a documented, justified number; `pnpm -r typecheck` +
  `pnpm -r test` green (KI-3-01 flakiness excepted). Manager writes `realtime-bridge-manager-notes.md`.

---

## 9. Verification ladder (definition of "done" for the whole RFC)

1. `pnpm -r typecheck` + `pnpm -r test` green across the workspace.
2. WBS-1…3 gates passed (frame decode, live one-turn, double-barge-in).
3. **WBS-4 live proof** — the university late-add turn voiced by gpt-realtime-2 with the grounded answer
   (the bi-model payoff, observed end-to-end per CONTRIBUTING's bar).
4. WBS-5 latency delta measured and documented.
5. Manager notes written; no `as any` packet bypasses; R1–R7 satisfied.
