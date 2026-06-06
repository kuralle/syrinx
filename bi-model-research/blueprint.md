# Bi-Model `RealtimeBridge` — implementation blueprint

> The concrete shape the code would take for the "guardian front / meat back" architecture in Syrinx —
> backlog item **B-01**. Companion to [`README.md`](./README.md) (the research + rationale): this file is
> the *how*. Every adversarial-review fix from `README.md` §6 is baked in here as a first-class part of
> the design, not a patch. Fix tags (FIX A…H) cross-reference that section.

**One-liner:** a `RealtimeBridge` sibling `VoicePlugin` owns the live full-duplex provider socket
(`gpt-realtime` / Gemini Live / Moshi); the existing `Reasoner` seam is reused **verbatim** as a delegate
"meat" tool; `llm.tool_call`/`llm.tool_result` are the `<ret>`-style handoff. No kernel change.

---

## 1. System shape

```
                          ┌─────────────────────────  Syrinx VoiceAgentSession  ─────────────────────────┐
                          │                              PipelineBus (Critical/Main/Bg)                    │
   client/telephony       │                                                                               │
   ┌──────────┐  PCM16    │   user.audio_received ─────────────┐                                          │
   │ browser/ │ ───────►  │                                    ▼                                          │
   │ Twilio   │           │                          ┌──────────────────────┐   tts.audio (16k)           │
   │ /ws,/twi │ ◄───────  │   tts.audio / tts.end ◄──│   RealtimeBridge      │──────────► edge encoder ──► │ ──► client
   └──────────┘  audio    │   interrupt.tts (Crit) ─►│   (VoicePlugin, B-01) │                            │
                          │   llm.tool_call/result ◄─│                       │                            │
                          │                          └─────────┬────────────┘                            │
                          └────────────────────────────────────┼─────────────────────────────────────────┘
                                         duplex WS │            │ in-proc call (delegate tool)
                                                   ▼            ▼
                                      ┌────────────────────┐   ┌──────────────────────────┐
                                      │  FRONT s2s model   │   │  BACK "meat" Reasoner     │
                                      │  gpt-realtime /    │   │  reasoner.stream(turn)    │
                                      │  Gemini Live /     │   │  = fromMastraAgent(...) / │
                                      │  Moshi  (24kHz)    │   │    fromStreamText(...)    │
                                      └────────────────────┘   └──────────────────────────┘
                                       owns: VAD, turns, STT,    owns: RAG, reasoning, tools
                                       TTS, understanding         (async, off the hot path)
```

Two new things only: **`RealtimeBridge`** (the plugin) and a **duplex provider socket** in `packages/ws`.
Everything else — bus, transport, recorder, paced playout, the `Reasoner` seam — is reused.

---

## 2. File layout (smallest footprint)

```
packages/realtime/                      # new package @kuralle-syrinx/realtime
  src/
    realtime-bridge.ts                  # the VoicePlugin (B-01)
    realtime-adapter.ts                 # the RealtimeAdapter interface + shared types
    from-openai-realtime.ts             # fromOpenAIRealtime(opts) -> RealtimeAdapter
    from-gemini-live.ts                 # fromGeminiLive(opts)  (reduced-capability flag)
    from-moshi.ts                       # fromMoshi(opts)       (embedding-sum path, owned model)
    index.ts
packages/ws/src/
    realtime-socket.ts                  # new: full-duplex provider socket (current ws = cascade only)
```

> `packages/ws`'s current outbound socket serves cascade STT/TTS; the full-duplex realtime socket is new
> wiring there. Its exact current API is unread — confirm before coding (noted in `README.md` §6).

---

## 3. Core interfaces

### 3.1 The provider adapter (provider-agnostic, mirrors the `Reasoner` `from*` pattern)

```ts
// realtime-adapter.ts
export interface RealtimeAdapter {
  readonly caps: {
    inputSampleRateHz: number;            // e.g. 24000 — resample 16k user audio IN to this   (FIX E)
    outputSampleRateHz: number;           // e.g. 24000 — resample provider audio OUT to 16k    (FIX E)
    supportsConcurrentToolAudio: boolean; // gpt-realtime async-fn-calling: true; Gemini Live: false (FIX B/C)
    supportsTruncate: boolean;            // gpt-realtime: true                                  (FIX D)
  };

  open(signal: AbortSignal): Promise<void>;
  sendAudio(pcm16: Uint8Array): void;            // bridge feeds user audio (already resampled IN)
  cancelResponse(audioEndMs: number): void;      // barge-in: response.cancel + conversation.item.truncate
  injectToolResult(toolId: string, text: string): void; // function_call_output (+response.create iff !concurrent)

  readonly events: AsyncIterable<RealtimeEvent>; // provider -> bridge, normalized
}

export type RealtimeEvent =
  | { type: "audio";          pcm16: Uint8Array; sampleRateHz: number }
  | { type: "speech_started" }                          // server-VAD: user barged in
  | { type: "transcript";     role: "user" | "assistant"; text: string; final: boolean }
  | { type: "tool_call";      toolId: string; toolName: string; args: Record<string, unknown> }
  | { type: "response_started" }                        // -> mint fresh contextId            (FIX A)
  | { type: "response_done" }                           // -> emit turn boundary / re-arm     (FIX A)
  | { type: "error";          cause: Error; recoverable: boolean };
```

### 3.2 The bridge (a normal `VoicePlugin`, holds the adapter + an optional delegate `Reasoner`)

```ts
// realtime-bridge.ts
export class RealtimeBridge implements VoicePlugin {
  constructor(
    private adapter: RealtimeAdapter,
    private reasoner?: Reasoner,            // the BACK "meat" model — the existing seam, unchanged
    private delegateToolName = "deep_reasoning",
  ) {}

  private bus!: PipelineBus;
  private contextId!: string;              // FRESH per realtime turn — NOT a fixed "realtime"     (FIX A)
  private playedMs = 0;                    // from playout clock, for truncate                     (FIX D)
  private inflight?: AbortController;       // delegate abort, driven by interrupt.tts              (FIX)
  private history: ReasonerMessage[] = [];

  async initialize(bus: PipelineBus, _cfg: PluginConfig) {
    this.bus = bus;
    // (1) user audio  -> provider (resample 16k -> adapter.caps.inputSampleRateHz)               (FIX E)
    bus.on<RecordUserAudioPacket>("user.audio_received", p =>
      this.adapter.sendAudio(resample(p.audio, 16000, this.adapter.caps.inputSampleRateHz)));
    // (2) barge-in OUT-clear half: cancel provider (+truncate) and abort the in-flight delegate
    bus.on("interrupt.tts", () => { this.adapter.cancelResponse(this.playedMs); this.inflight?.abort(); });
    bus.on<TtsPlayoutProgressPacket>("tts.playout_progress", p => { this.playedMs = p.playedMs; });
    await this.adapter.open(/* session signal */);
    void this.pump();
  }

  private async pump() {
    for await (const ev of this.adapter.events) {
      switch (ev.type) {
        case "response_started":            // FIX A: scope every turn's interrupted-flag
          this.contextId = freshId();
          this.bus.push(Route.Main, { kind: "turn.change", contextId: this.contextId, /*…*/ });
          break;
        case "audio":                       // FIX E + F: resample to 16k, chunk to <=20ms to bound burst
          this.bus.push(Route.Main, {
            kind: "tts.audio", contextId: this.contextId,
            audio: chunkTo20ms(resample(ev.pcm16, ev.sampleRateHz, 16000)),
            sampleRateHz: 16000, timestampMs: now(),
          });
          break;
        case "speech_started":              // detection half -> existing barge-in machinery
          this.bus.push(Route.Critical, { kind: "interrupt.detected", source: "vad", contextId: this.contextId /*…*/ });
          break;
        case "transcript":
          if (ev.final) this.bus.push(Route.Main, { kind: "stt.result", contextId: this.contextId, text: ev.text /*…*/ });
          break;
        case "tool_call":
          if (ev.toolName === this.delegateToolName && this.reasoner) await this.runDelegate(ev);
          break;
        case "response_done":               // FIX A: re-arm path (turn boundary) + drain
          this.bus.push(Route.Main, { kind: "eos.turn_complete", contextId: this.contextId /*…*/ });
          this.bus.push(Route.Main, { kind: "tts.end", contextId: this.contextId /*…*/ });
          break;
        case "error":                       // FIX: real VoiceErrorPacket shape (category/cause/isRecoverable)
          this.bus.push(Route.Critical, { kind: "llm.error", category: categorizeLlmError(ev.cause),
            cause: ev.cause, isRecoverable: ev.recoverable /*…*/ });
          break;
      }
    }
  }
}
```

---

## 4. The delegate loop (front → back → front) — full `ReasoningPart` contract

The `<ret>` handoff. Mirrors `ReasoningBridge.processTurn`'s switch — the fix for an "only accumulate
deltas" loop that would inject an empty answer for `finish.text` backends and swallow `suspended`.

```ts
private async runDelegate(ev: { toolId: string; args: Record<string, unknown> }) {
  this.bus.push(Route.Main, { kind: "llm.tool_call", contextId: this.contextId,
    toolId: ev.toolId, toolName: this.delegateToolName, toolArgs: ev.args /*…*/ });

  this.inflight = new AbortController();
  let answer = "";
  try {
    for await (const part of this.reasoner!.stream({
      userText: String(ev.args.query ?? ""),
      messages: this.history,          // bridge owns whatever context it chooses to pass
      signal: this.inflight.signal,
    })) {
      switch (part.type) {
        case "text-delta":  answer += part.text; break;
        case "tool-result": /* nested tool — optionally surface as observability */ break;
        case "finish":      answer = answer || part.text; break;            // FIX H: finish carries text
        case "suspended":   throw new Error("delegate suspended — cannot voice inline"); // FIX H: terminal
        case "error":       if (!part.recoverable) throw part.cause; break;
      }
    }
  } catch (e) {
    // AbortError == barge-in (expected, swallow); otherwise surface as llm.error
  }

  this.bus.push(Route.Main, { kind: "llm.tool_result", contextId: this.contextId,
    toolId: ev.toolId, toolName: this.delegateToolName, result: answer /*…*/ });

  // FIX B: inject back. With concurrent-tool-audio the adapter just hands the result to the model;
  //        otherwise injectToolResult also fires response.create internally.
  this.adapter.injectToolResult(ev.toolId, answer);
}
```

---

## 5. Timing model — honest version (FIX B/C)

The enabling insight (result lands before the "meat") holds **only** if the front model keeps talking
while the call is pending. Two regimes, selected by `caps.supportsConcurrentToolAudio`:

```
gpt-realtime  (async function calling — supportsConcurrentToolAudio: true):
  user query ─┐
              ▼
  front: "Let me check that for you…"  ──(keeps talking)──►  …grounded body…
              │  tool_call                       ▲
              └──► reasoner.stream() ────────────┘ injectToolResult (model folds it in itself)
              ◄────── back-model TTFT hidden here ──────►        ← do NOT call response.create

Gemini Live / Moshi-context  (supportsConcurrentToolAudio: false):
  front emits tool_call → MODEL GOES SILENT (blocking) → injectToolResult + response.create → body
              ◄──────── audible gap = back-model TTFT ────────►  ← needs explicit "one moment" filler
```

- Config (A) ≈ Fin: the gap is hidden under the lead-in.
- Config (B)/Gemini is **reduced-capability**: a real, measured gap. Not silently "the same seams,
  only the adapter differs" — the `caps` flag makes the difference explicit and the bridge inserts a
  stall filler when it's false.

> Do **not** claim "perceived latency → zero" for the manual `function_call_output` + `response.create`
> path: emitting the function call ends the response; lead-in and body become two responses with a real
> gap. Native async function calling is the mechanism that actually keeps one fluid turn.

---

## 6. Per-turn `contextId` lifecycle (FIX A — the mute bug)

The single most important correctness detail. The session re-arms audio only on `eos.turn_complete` and
scopes the barge-in mute flag (`interruptedGenerationContextIds`) by `contextId`. A fixed
`contextId="realtime"` + no `eos.turn_complete` ⇒ **after the first barge-in, every `tts.audio` frame is
dropped forever.**

```
provider response_started  ──►  contextId = fresh()  +  push turn.change
provider audio…            ──►  tts.audio { contextId }                 (plays)
user barges in             ──►  interrupt.detected → interrupt.tts      (THIS contextId muted)
provider response_done     ──►  push eos.turn_complete { contextId }    (re-arm) + tts.end
NEXT provider response      ──►  contextId = fresh()  → clean slate, audio NOT dropped
```

Verified by a **double-barge-in session test**: barge in twice on one session, assert the 2nd turn's
`tts.audio` is not dropped.

---

## 7. Endpointing & invariants that relocate (disclosures, not bugs)

- **Endpointing ownership.** Run the session with `endpointingOwner: "timer"` so VAD/STT/EOS plugins are
  skipped (the s2s model does its own turn detection). The kernel's "exactly one EOS finalizer"
  invariant is satisfied by opting out — worth a zero-debt pass so it doesn't become an `if (realtime)`
  flag through the session.
- **Kernel barge-in policy bypassed.** `TurnArbiter`, `minInterruptionMs` (280 ms), `PrimarySpeakerGate`
  echo-suppression are `vad.*`-driven and won't fire — barge-in *timing/quality policy* moves into the
  provider's server-VAD. Only the *output-clear* half (`interrupt.tts → audio_clear`) is reused.
- **Spoken-prefix history correctness** (`ReasoningBridge`'s feature, gated on `tts.word_timestamps`)
  does **not** transfer — the s2s model owns its own context and Syrinx has no word timestamps for
  provider audio. If the back `Reasoner` keeps separate history, reconciling it on barge-in is a new
  problem with no current machinery.

---

## 8. Config — how a user wires it

```ts
// Config A — the Fin shape (closed realtime front + Mastra/AISDK RAG back)
session.registerPlugin("realtime", new RealtimeBridge(
  fromOpenAIRealtime({
    model: "gpt-realtime", voice: "marin",
    tools: [{ name: "deep_reasoning", description: "answer knowledge/RAG questions" }],
  }),
  /* a Reasoner: */ fromMastraAgent(ragAgent),   // or fromStreamText({...})
));
// session runs with endpointingOwner: "timer" — no STT/VAD/TTS/bridge plugins on the live path

// Config B — the MoshiRAG shape (owned front, embedding-sum injection available)
session.registerPlugin("realtime", new RealtimeBridge(fromMoshi({ /*…*/ }), reasoner));
```

The front model **is** STT + LLM + TTS for the live path, so none of those plugins are registered.

---

## 9. Build order (each phase ends in a gate)

| # | Build | Gate (must observe, not assume) |
|---|---|---|
| 1 | `RealtimeAdapter` + `fromOpenAIRealtime` + duplex socket in `packages/ws` | Decode a **real** provider frame through `decodeSyrinxAudioEnvelope` without throwing (proves 24k→16k resample, FIX E) |
| 2 | `RealtimeBridge` audio path (no delegate) | One live turn: audio plays end-to-end; `endpointingOwner:"timer"` |
| 3 | Barge-in (detection + cancel + truncate + fresh `contextId`) | **Double-barge-in session test** (FIX A/D) |
| 4 | Delegate loop + `Reasoner` wiring | Fake-`Reasoner` unit tests: `finish`-with-text-no-deltas, and `suspended` (FIX H) |
| 5 | **Live VE-01 smoke** | First-audio latency: direct `gpt-realtime` vs via-`RealtimeBridge`; assert delta within the ~800 ms–1 s budget (FIX G). The "observed end-to-end" proof. |

---

## 10. What's reused vs new

**Reused unchanged:** `PipelineBus` + Route model; `VoicePlugin` contract + `registerPlugin`; transport
(in `user.audio_received`, out `tts.audio`/`tts.end`, paced playout, `audio_clear`, telephony adapters);
recorder, idle timeout, observability, playout clock; **the `Reasoner` seam and all its adapters**
(`fromAiSdkAgent`/`fromStreamText`/`fromMastraAgent`); `llm.tool_call`/`llm.tool_result` as the handoff.

**Genuinely new (the B-01 work):** the `RealtimeBridge` `VoicePlugin`; a duplex provider socket in
`packages/ws`; the provider-event → bus mapping; the resample-in/resample-out + ≤20 ms chunking; the
per-turn `contextId` lifecycle; the `caps`-driven concurrent-vs-blocking timing handling. Optionally a
typed `reasoning.delegate_requested/_result` packet pair if a distinct `<ret>` timeline event is wanted
(default: reuse `llm.tool_*`, zero kernel change).

---

*Grounding: see [`README.md`](./README.md) §4–§8 and its source-to-claim ledger. Syrinx seam citations
(`reasoner.ts`, `packets.ts`, `pipeline-bus.ts`, `voice-agent-session.ts`, `edge.ts`,
`outbound-playout-pipeline.ts`, `audio-envelope.ts`, `docs/rfc-reasoner-bridge.md:50,304,321`) are listed
there with file:line.*
