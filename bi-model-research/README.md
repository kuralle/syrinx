# Bi-Model Voice Architecture — research reading

> **Question:** how do we replicate, or give a primitive for, the way **Fin Voice 2** combines an
> s2s realtime model (OpenAI `gpt-realtime`) with a separate model that "handles the meat" — a
> *guardian* front model over a reasoning/RAG back model — and how do we support that architecture
> in Syrinx?
>
> **Answer in one line:** it's backlog item **B-01** (`RealtimeBridge`, a sibling `VoicePlugin`) +
> the **existing `Reasoner` seam reused verbatim as a delegate tool** + the **existing
> `llm.tool_call`/`llm.tool_result` packets as the `<ret>`-style handoff**. The kernel, transport,
> recorder and paced-playout path don't change. The hard parts are all in one new adapter — and
> several of them are *not* "for free" (see §6, the corrections from adversarial review).

Compiled 2026-06-06 from four primary sources, all mirrored under `sources/` + `fin-reading.md`, the
cloned `moshi-rag/` reference impl, and the parsed paper `moshirag-2604.12928.txt`. Design produced and
adversarially reviewed by a 6-agent workflow; every load-bearing claim is grounded in a source file or
Syrinx `file:line`.

## Reading order

1. This file (the synthesis + the Syrinx design). For the concrete *how* — interfaces, the delegate
   loop, the contextId lifecycle, build phases — see [`blueprint.md`](./blueprint.md).
2. `fin-reading.md` — the Fin Voice 2 architecture note (the motivating case).
3. `sources/kyutai-moshirag-blog.md` + `moshirag-2604.12928.txt` + `moshi-rag/` — the one system that
   ships the full mechanism in open code.
4. `sources/tml-interaction-models-blog.md` (+ `…-yt-transcript.md`) — the frontier "do it all in one
   learned model" end of the spectrum.

---

## 1. The shared pattern — "guardian front / meat back"

All three systems split the assistant into **two co-resident models with asymmetric jobs**:

- A **fast, always-present FRONT model** owns *real-time presence* — it listens, holds the turn, tracks
  whether the user is thinking / yielding / self-correcting, interprets messy speech, and starts
  speaking immediately.
- A **heavier, ASYNCHRONOUS BACK model** owns *the "meat"* — RAG, reasoning, tool/search calls — and
  runs in parallel **without blocking the conversation**.

The front model **triggers** a handoff when it detects a knowledge/reasoning-demanding query, keeps the
dialogue alive with a natural lead-in while the back model works, then **injects** the back result into
its live stream *before it reaches the informative part of the answer*. The thesis, stated almost
identically by Kyutai and Thinking Machines: a speech model **"does not have to be the entire voice
assistant itself"** — you get *the responsiveness of a non-thinking model at the intelligence of a
reasoning one*. The user's "guardian over a model that handles the meat" framing is exactly this: the
front model is the guardian of interactivity; the back model is the meat.

| | **Fin Voice 2** | **Kyutai MoshiRAG** | **TML Interaction Models** |
|---|---|---|---|
| **FRONT** (presence / understanding) | OpenAI `gpt-realtime` (**closed** s2s API) — picked because input speech is "really complicated": corrections like *"3,4,5, actually sorry that's 4,6"* | **Moshi 7B**, full-duplex, 12.5 Hz, **owned + finetuned**; + a 1B streaming ASR (0.5 s) to make text for the back end | Learned **time-aware interaction model** (276B MoE/12B active), 200 ms micro-turns, **no VAD harness** |
| **BACK** (the meat) | **Fin Apex Flash** — custom distilled RAG model, beats frontier models 1–2 OOM larger | Pluggable **text-in/text-out**: Gemma-3-27B / GPT-4.1 / Tavily search (`llm/client.py` = plain `chat.completions`) | Async **background model** for reasoning/tools/search/UI ("builds on … MoshiRAG") |
| **TRIGGER** | Undisclosed; UI shows discrete "RAG lookup / tool call" events | Inline **`<ret>` token** (`rag_token_id:4`); fires `rag_manager.trigger()` | Learned "delegate to a background model" decision |
| **INJECT back** | **Inferred:** function-call/tool-output text the closed model re-voices; **half-cascade** TTS renders final audio | **Embedding summation** into a model they own: ref → ARC-Encoder (4× compress) → `input_ = input_ + streaming_sum_condition` (`lm.py:410`, Eq. 2) | Internal/learned; "results interleaved at a moment appropriate to what the user is doing" |
| **HIDE latency** | Fast front + *shrink the back model* (Apex Flash) so chaining doesn't hurt UX | **The natural keyword-delay gap** (≥2 s lead-in before the keyword); ref must land before the *body*, not before speaking | Front "remains present throughout"; turn-taking latency **0.40 s** |

## 2. The key enabling insight

**The back result only needs to arrive before the *meat* of the answer is spoken — not before speaking
starts.** Kyutai, verbatim: the retrieval result *"doesn't need to be ready before MoshiRAG starts
speaking — it only needs to arrive before the most important part of the answer is generated."* In
natural speech the keyword rarely lands in the first words — humans open with a lead-in (*"In the
Netflix series 'Emily in Paris,'…"*) before the fact (*"…Chicago…"*). The paper measures this as
**End-to-End Keyword Delay** and finds a **natural ≥2 s gap** between end-of-query and keyword onset —
enough to finish retrieval. MoshiRAG *engineers its training data* around it: RAG turns are
**lead → reference-grounded body → optional tail**, `<ret>` at the start of the lead, a retrieval-delay
sampler guaranteeing ≥1 s of buffer (`rag_time_sampling_params: {start_delay:1.0, end_gap:1.0}`).
**Net effect: perceived retrieval latency → zero**, because the slow path overlaps an unavoidable,
naturally-occurring preamble.

## 3. The critical divergence — injection (this decides everything for Syrinx)

This is the fork that determines what a self-hostable engine can actually do.

**Open systems (MoshiRAG/TML) inject *below the token layer* — only possible on a model you own.**
The projected reference embedding is **added into the front model's residual stream** over `l` streaming
steps. Confirmed in the cloned repo: `configs/moshirag.json` → `fuser.streaming_sum:["reference_with_time"]`
+ a `multi_arc_encoder` (`kyutai/ARC4_Encoder_Llama`, 4× compression); `inference_job.py:157-166`
(`_async_update_reference` → `update_streaming_sum_tensors`); and the literal op in
`models/lm.py:404-410` — **`input_ = input_ + streaming_sum_condition`**. This is tensor addition, not a
prompt. It requires gradient access: the front model was *trained to consume a summed embedding
mid-stream* without breaking audio generation. The back end is the boring part (plain text I/O); the
cleverness is the owned, finetuned front.

**A closed s2s API (`gpt-realtime`) gives you none of that** — no residual stream, no encoder fusion,
no finetuning the audio decoder. So **Fin cannot be using the MoshiRAG mechanism.** It must re-feed the
back answer *at the token/context layer*: the front model emits a tool/function call, the harness routes
the query to Apex Flash, and Apex Flash's text returns as a **`function_call_output` conversation item**
that the realtime model then voices (half-cascade TTS renders it). This matches Fin's disclosed UI
("RAG lookup / tool call" indicators) and is the API-native realization of `<ret>` — *at the
conversation-item level instead of the residual-stream level.* (The exact realtime call Fin uses is
**inferred**, not stated in the source.)

> **Consequence for Syrinx:** if you ever own a Moshi-class front model, copy MoshiRAG literally. But
> for the realistic near-term — sitting behind `gpt-realtime` / Gemini Live — **you are structurally
> forced into Fin's tool-output/conversation-item injection**, and the right lever is the **back
> model's TTFT** (distillation / RAG-specialization), not an embedding-fusion path you can't access.

---

## 4. How Syrinx supports this — the design

**The good news: the seam already anticipated this.** `docs/rfc-reasoner-bridge.md:50,304` pin B-01 as
*"a **sibling** `VoicePlugin` (consumes `user.audio_received`, emits `tts.audio`), not a `Reasoner`"*
and *"a `Reasoner` plugs into it later as a **delegate tool** — no change to this seam."* That is
exactly this architecture.

### 4.1 The front: a `RealtimeBridge` `VoicePlugin` (the new code = B-01)

A thin adapter between `packages/ws` (the outbound provider socket manager) and the bus. It **replaces
the STT+TTS+turn-taking stack for the live path** because the s2s model *is* STT+LLM+TTS — but it speaks
the same packet vocabulary, so the kernel/transport/recorder are untouched.

- **Consumes** `user.audio_received` (PCM16 mono, `packets.ts:121`) → forwards each chunk into the
  provider duplex socket. Same packet the transport already pushes (`edge.ts:392`) and the recorder taps.
- **Emits** `tts.audio{audio,sampleRateHz}` (`packets.ts:318`) ← provider audio. This is the load-bearing
  reuse — the wire encoder, recorder, idle-timeout and playout clock all key on `tts.audio`.
- **Emits** `tts.end` per response; **optionally** `stt.result`/`stt.interim` (provider transcripts, for
  the timeline/history) and `llm.delta`/`llm.done` (text timeline only).
- Provider-agnostic via **named adapters**, mirroring the `Reasoner` pattern
  (`fromAiSdkAgent`/`fromMastraAgent`) → `fromOpenAIRealtime`, `fromGeminiLive`, (`fromMoshi`).

### 4.2 The back: reuse the `Reasoner` seam **verbatim** as a delegate tool

`Reasoner.stream(turn) → AsyncIterable<ReasoningPart>` (`reasoner.ts:22`) is *exactly* a "meat"
reasoner's shape. `ReasonerTurn` needs only `{userText, messages, signal}` — all suppliable by the front
model. Wire it as **option A (delegate tool)**, not option B (parallel `llm.*` plugin):

> The s2s provider is configured with a tool (`deep_reasoning(query)` / a retrieval tool). When the
> front model emits the tool-call, the `RealtimeBridge` calls `reasoner.stream(turn)` **in-process**,
> collects the parts, and feeds the result **back into the provider socket** as the tool result, so the
> front model speaks the answer in its own voice.

**Why not option B (a second `ReasoningBridge` emitting `llm.delta`)?** It would route into
`bufferTtsText → tts.text → a second TTS`, double-speaking against the front model's own audio. The
single-audio-source invariant (`voice-agent-session.ts:797-826`) forbids it. **Option A is correct.**

### 4.3 The handoff (front → back) — reuse `llm.tool_call`/`llm.tool_result`, no new packet

The Syrinx-native analog of `<ret>` is **a tool-call whose executor is a `Reasoner`**:

1. front model emits its delegate tool → push `llm.tool_call{toolId,toolName,toolArgs}`
   (`packets.ts:277`) so the existing `agent_tool_call` timeline records the excursion;
2. invoke `reasoner.stream({userText: toolArgs.query, messages, signal})` in-process;
3. push `llm.tool_result` (`packets.ts:284`) and feed `result` back into the provider socket.

Zero kernel change. Add a typed `reasoning.delegate_requested/_result` pair (modeled on the existing
`reasoning.suspended`/`resume`, `packets.ts:291-302`) **only if** you later want the back-excursion to be
a distinct, queryable timeline event.

### 4.4 Two configurations, same seams

- **(A) Fin shape — closed front:** `fromOpenAIRealtime(...)` front + any existing `Reasoner`
  (`fromMastraAgent`/`fromStreamText`) RAG back. Injection via `function_call_output`.
- **(B) MoshiRAG shape — open front:** `fromMoshi(...)` front + same `Reasoner` back. *Here, and only
  here,* the embedding-sum injection path is available because you own the weights.

---

## 5. Why it respects the latency budget

The back excursion is **async and off the critical voice path by design** — the whole point of bi-model.
First audio is gated only by the **front model's own TTFB**; the `<ret>`/tool round-trip happens *after*
the front has started speaking its lead-in, exactly as MoshiRAG overlaps retrieval with speech. The
`Reasoner` seam's no-buffering invariant (`reasoner.ts:13-21`) still holds for the back stream. The gate
to measure (per `docs/latency-budget.md`): that pushing the infrequent `llm.tool_call` on Main does not
contend with live `tts.audio` frames.

---

## 6. Corrections from adversarial review — the "NOT free" list

The first-pass design over-claimed several reuses as "for free." Three adversarial reviewers (Syrinx
contracts / closed-API feasibility / latency-transport) found these. **The architecture survives; these
are the real implementation obligations.** Treat this section as the build checklist.

**A. Barge-in is *not* free — the single fixed `contextId` permanently mutes the agent.** `bug, blocker`
The session clears its barge-in mute flag (`interruptedGenerationContextIds`) **only** inside
`handleTurnComplete` on `eos.turn_complete` (`voice-agent-session.ts:696`). A naive `RealtimeBridge`
emits no `eos.turn_complete` and reuses one fixed `contextId="realtime"` for the whole session → after
the **first** barge-in, `handleTtsAudio` drops every subsequent `tts.audio` frame *forever*
(`:875-881`). **Fix:** mint a **fresh `contextId` per realtime turn** (on the provider's
response/speech boundary) **and** emit a turn-boundary packet that runs the re-arm path. Prove with a
session test that barges in **twice** and asserts the 2nd turn's audio is not dropped.

**B. The "one continuous utterance" timing model is wrong for the closed API.** `blocker`
Under the manual `function_call_output` + `response.create` path, **emitting the function call ENDS the
response** (`response.done` fires). The lead-in and the grounded body are **two separate responses** with
a real gap (back-TTFT + your round-trip + 2nd-response TTFB) and a fresh TTFB between them — *not* one
stream into which the result is woven. So "perceived latency → zero" does **not** hold for the manual
path. The feature that *does* keep the model talking while a call is pending is `gpt-realtime`'s
**native asynchronous function calling** — a **different mechanism** the design conflated with manual
injection. **Fix:** pick one explicitly. If async function calling: return `function_call_output` and do
**not** drive `response.create` (the model folds it in on its own schedule). If manual: accept the
two-response gap and **cover it with a real bridge-side filler/backstop** (a Syrinx timer *is* needed —
don't claim the provider "holds the turn"). Gate on a live `gpt-realtime` smoke (VE-01).

**C. Gemini Live can't do the lead-in-while-pending pattern.** `blocker for config parity`
Gemini Live function calling is **blocking** ("the model will not start responding until you've sent the
tool response"); async function calling is *not yet supported*. So `fromGeminiLive` is **not**
latency-equivalent to `fromOpenAIRealtime`. **Fix:** add a provider capability flag
(`supportsConcurrentToolAudio`); on Gemini, fall back to an explicit "one moment" stall and measure the
gap. Don't present (B)/Gemini as parity.

**D. Barge-in needs `conversation.item.truncate`, not just cancel.** `major`
For `gpt-realtime`, cancelling the response is insufficient: you must send `conversation.item.truncate`
to tell the server how much audio the user **actually heard** (client owns playback), or the model later
references audio that was never played. **Fix:** track played-ms from Syrinx's paced playout clock and
emit `conversation.item.truncate(item_id, audio_end_ms)` on barge-in. Carry played-ms on the provider
seam.

**E. Provider audio is 24 kHz — the browser edge will reject every frame.** `blocker`
`gpt-realtime`/Gemini Live emit **24 kHz** PCM16. The browser `/ws` edge stamps the envelope with the
provider rate but computes `durationMs` against `outputSampleRateHz=16000` (`edge.ts:353` vs `:357/367`),
and the client decoder rejects any envelope whose duration disagrees with `byteLength/sampleRateHz`
(`audio-envelope.ts:129-133`) → **every assistant frame rejected.** **Fix:** the adapter must **resample
provider audio → 16 kHz** before emitting `tts.audio` (and **resample 16 kHz user audio → the provider's
native input rate** on the way in — `user.audio_received` is already 16 kHz with no rate field). Add a
smoke that decodes a real provider frame through `decodeSyrinxAudioEnvelope` without throwing.

**F. Paced playout is telephony-only; a realtime provider bursts faster than realtime.** `major`
`PacedPlayoutQueue` is wired **only** in the telephony adapters; the browser `/ws` path sends
unpaced and relies on the client jitter buffer. A realtime s2s provider emits a full response's audio in
a fast burst → risk of the 8 MiB outbound ceiling (`1013`) and a swamped client buffer; and there's no
server queue for `audio_clear` to clear. **Fix:** chunk provider audio to ≤20 ms frames in the adapter
(bounds the burst, keeps `audio_clear` effective), or route realtime sessions through a server-side pacer
on the browser path too (a transport change — scope it deliberately).

**G. "~0 added latency" is dishonest — it's one provider hop + two resamples + per-frame bus dispatch.**
`major` Topology is `client ↔ Syrinx ↔ provider-realtime`: a genuine second WS leg, plus input/output
resampling, plus the bus tick per `tts.audio` frame. **Fix:** reframe the invariant honestly and **gate
it empirically** — VE-01 smoke comparing first-audio latency of direct `gpt-realtime` vs
`gpt-realtime`-via-`RealtimeBridge`; co-locate Syrinx with the provider region.

**H. The delegate loop must handle the full `ReasoningPart` contract.** `blocker`
`finish` carries `{reason, text}`; `suspended` is **terminal**. A loop that only accumulates `text-delta`
injects an empty answer for backends that deliver via `finish.text`, and silently swallows `suspended`
(which `fromMastraAgent` can emit — the design's own back end). **Fix:** mirror
`ReasoningBridge.processTurn`'s switch (accumulate deltas, read `finish`, explicitly handle/reject
`suspended`). Unit-test a fake `Reasoner` yielding a `finish`-with-text-no-deltas and a `suspended`.

> Also: the first-pass design cited adapter exports at `aisdk/src/index.ts:29-35`; the real adapter
> definitions live in `packages/aisdk/src/from-ai-sdk.ts` — re-read that file before trusting any
> `ReasoningPart`-production detail.

---

## 7. Endpointing & invariants that *relocate* (not bugs, but disclosures)

- **Endpointing ownership.** The cascade enforces exactly-one EOS finalizer
  (`voice-agent-session.ts:1105-1126`). The s2s path has none and must run `endpointingOwner:"timer"` so
  VAD/STT/EOS plugins are skipped. Satisfying the invariant by **opting out** of it — worth a zero-debt
  pass so it doesn't become an `if (realtime)` flag sprinkled through the session.
- **Kernel barge-in policy bypassed.** `TurnArbiter`, `minInterruptionMs` (280 ms), `PrimarySpeakerGate`
  echo-suppression are all `vad.*`-driven and won't fire. Barge-in *timing/quality policy* moves into the
  provider's server-VAD; only the *output-clear* half (`interrupt.tts → audio_clear`) is reused.
- **Spoken-prefix history correctness** (`ReasoningBridge`'s signature feature, `aisdk/src/index.ts`,
  gated on `tts.word_timestamps`) **does not transfer** — the s2s model owns its own context and Syrinx
  has no word timestamps for provider audio. If the back `Reasoner` keeps separate history, reconciling
  it on barge-in is a **new problem with no current machinery**.

---

## 8. Smallest-footprint build plan

1. **New package `@kuralle-syrinx/realtime`** (or fold into `core` + `ws`): the `RealtimeBridge`
   `VoicePlugin` + `fromOpenAIRealtime` adapter. Holds a `private reasoner?: Reasoner`.
2. **Duplex realtime socket in `packages/ws`** speaking the OpenAI Realtime protocol (current `ws`
   serves cascade STT/TTS; full-duplex is new wiring — *its exact API is unread, confirm before coding*).
3. **Provider-event → bus mapping:** `audio → tts.audio` (**resampled to 16 kHz**, §6E);
   `speech_started → interrupt.tts(Critical)` + **fresh contextId** (§6A); `transcript → stt.result`;
   `tool_call → llm.tool_call` + `reasoner.stream()` → `llm.tool_result` + `function_call_output`
   (+ `truncate` on barge-in, §6D).
4. **Run with `endpointingOwner:"timer"`**, no STT/VAD/EOS plugins.
5. **Gates before "done":** (a) decode-a-real-provider-frame smoke (§6E); (b) double-barge-in session
   test (§6A); (c) `finish`/`suspended` delegate unit tests (§6H); (d) **live VE-01** first-audio-latency
   delta direct-vs-bridged (§6G) — this is the empirical proof the whole thing works end to end, per the
   repo's "observed end to end, not just unit tests" bar.

---

## Appendix — source-to-claim ledger

- **Pattern / "not the entire assistant" / latency-of-non-thinking-at-intelligence-of-reasoning:**
  `sources/kyutai-moshirag-blog.md`, `sources/tml-interaction-models-blog.md`.
- **Keyword-gap insight, ≥2 s, lead→body→tail, E2EKD, delay sampler:** `sources/kyutai-moshirag-blog.md`;
  `moshirag-2604.12928.txt` §3.1, §4.1.2, §4.2 (Eq. 3), Table 1, Fig. 5.
- **Eq. 2 summation / ARC-Encoder / `streaming_sum` (owned-model injection):** `moshirag-2604.12928.txt`
  §3.3.1; `moshi-rag/configs/moshirag.json`; `moshi-rag/.../inference_job.py:157-166,285-316`;
  `moshi-rag/.../models/lm.py:404-410`. Back end = plain text I/O: `moshi-rag/.../llm/client.py`.
- **Fin: gpt-realtime front, Apex Flash back, half-cascade TTS, tool/RAG UI events:** `fin-reading.md`.
  The realtime-API injection mechanism is **inferred**, not stated.
- **TML learned presence (micro-turns, no VAD), delegation, 0.40 s turn-taking:**
  `sources/tml-interaction-models-blog.md`, `sources/tml-interaction-models-yt-transcript.md`.
- **Syrinx seams (B-01, Reasoner seam, packets, barge-in, endpointing invariant, edge resample/pace):**
  `docs/rfc-reasoner-bridge.md:50,304,321`, `packages/core/src/{reasoner,packets,pipeline-bus,voice-agent-session}.ts`,
  `packages/server-websocket/src/{edge,outbound-playout-pipeline}.ts`, `packages/server-websocket/src/audio-envelope.ts`.
- **Closed-API mechanics (function_call_output, async function calling, `conversation.item.truncate`,
  Gemini Live blocking tool calls):** OpenAI Realtime docs + "Introducing gpt-realtime"; Gemini Live tools
  docs — verified during adversarial review, **gate on a live smoke before relying on them.**
