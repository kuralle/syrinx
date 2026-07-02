# Building a voice agent

You've got an idea — say a university helpline that answers from a handbook, remembers who called, and can book an advisor. Let's build it.

This guide walks you through the full stack we use in Syrinx examples: **kuralle-agents** as the brain (reasoning, RAG, flows, memory) and **Syrinx** as the voice engine (STT, TTS, turn-taking, WebSocket transport). Every API and snippet below is taken from this repo or from installed `@kuralle-agents/*@0.7.1` packages — nothing invented.

## Table of contents

1. [What you'll build](#what-youll-build)
2. [The 60-second mental model](#the-60-second-mental-model)
3. [Your first agent (text)](#your-first-agent-text)
4. [Give it knowledge (RAG)](#give-it-knowledge-rag)
5. [Give it procedures (flows)](#give-it-procedures-flows)
6. [Give it skills](#give-it-skills)
7. [Memory](#memory)
8. [Make it talk (cascade bridge)](#make-it-talk-cascade-bridge)
9. [Make it feel instant (bi-model)](#make-it-feel-instant-bi-model)
10. [All the bridges](#all-the-bridges)
11. [Ship it: Node, then Cloudflare](#ship-it-node-then-cloudflare)
12. [Gotchas we learned](#gotchas-we-learned)

---

## What you'll build

A **university support voice agent** that can:

- Answer admissions, tuition, and scholarship questions from a small markdown corpus (RAG).
- Load a scholarship-guidance skill when the model needs step-by-step procedure text.
- Run two multi-turn flows: book an advisor appointment, request a transcript.
- Remember the caller's name and program across turns (working memory).
- Speak over the Syrinx cascade (Deepgram STT → kuralle → Cartesia/Deepgram TTS), or feel snappier with a realtime front model that delegates hard questions to kuralle.

The working reference implementation lives in `examples/02-hello-voice-headless/src/university-agent-full.ts` (full kuralle stack) and `examples/02-hello-voice-headless/src/university-support-kuralle.ts` (voice wiring).

---

## The 60-second mental model

Think of two layers:

| Layer | Package | Job |
|-------|---------|-----|
| **Brain** | `@kuralle-agents/core` (+ `rag`, `skills`) | Sessions, tools, RAG, flows, memory — everything the model *decides*. |
| **Voice** | `@kuralle-syrinx/core` (+ STT/TTS plugins) | Audio in, turn boundaries, audio out, barge-in, WebSocket protocol. |
| **Bridge** | `@kuralle-syrinx/kuralle` or `@kuralle-syrinx/aisdk` | Adapts a reasoning backend to Syrinx's `Reasoner` seam so the voice pipeline can drive it turn by turn. |

Syrinx's LLM integration point is the **`Reasoner`** (`packages/core/src/reasoner.ts`):

```ts
interface Reasoner {
  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart>;
}
```

For the classic **cascade** path you wire `new ReasoningBridge(reasoner)` (`@kuralle-syrinx/aisdk`). The bridge listens for finalized user speech, calls `reasoner.stream(turn)`, and pushes `llm.delta` packets to TTS.

For **bi-model** voice you wire `new RealtimeBridge(adapter, reasoner?, delegateToolName)` (`@kuralle-syrinx/realtime`). A realtime front model (gpt-realtime or Gemini Live) handles live audio; when it needs facts it calls a delegate tool and Syrinx runs your kuralle `Reasoner` in the background.

---

## Your first agent (text)

Before adding voice, prove the brain works as text. Kuralle has one authoring primitive: **`defineAgent`**. Behavior is **derived from which fields you populate** — there is no mode enum (ADR 0007).

Relevant fields from `@kuralle-agents/core` `types/agentConfig.ts`:

| Field | Purpose |
|-------|---------|
| `id` | Required agent id. |
| `name?`, `description?` | Metadata. |
| `instructions?` | System prompt (string, `AgentPrompt`, or function). |
| `model` | An `ai@6` `LanguageModel` (e.g. `createOpenAI(...)(id)`). |
| `controlModel?` | Optional cheaper model for routing/extraction (temperature 0). |
| `tools?` | Durable effect tools (`Record<string, Tool>`). |
| `globalTools?` | Always-visible safe tools on every speaking turn. |
| `flows?` | Structured node graphs → flow agent. |
| `routes?`, `routing?`, `agents?` | Router / composition. |
| `handoffs?` | Allowed handoff targets. |
| `knowledge?` | RAG config (`autoRetrieve`, `sources`). |
| `memory?` | Working memory, preload, ingest. |
| `skills?` | Bundled procedural skills. |
| `guardrails?`, `limits?` | Safety and caps. |
| `validate?`, `refine?` | Post/pre-turn policies. |
| `workspace?` | Filesystem tool surface. |

Populate `flows` → flow agent. Populate `routes` / `agents` → router. Populate none of those with only `instructions` + `tools` → plain chat.

### A tool and an agent

From `@kuralle-agents/core` `types/effectTool.ts`:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent, defineTool, createRuntime, MemoryStore } from "@kuralle-agents/core";
import { z } from "zod";

const echo = defineTool({
  name: "echo",
  description: "Echo the input text",
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const agent = defineAgent({
  id: "support",
  instructions: "You are a helpful support agent.",
  model: openai("gpt-4.1-mini"),
  tools: { echo },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: "support",
  sessionStore: new MemoryStore(),
});
```

`defineTool` tools are **durable effect tools**: logged and exactly-once on replay.

### Run a turn

`createRuntime` returns a `Runtime` (`runtime/Runtime.d.ts`). Call `runtime.run({ input, sessionId, userId })` → `TurnHandle`. Iterate `handle.events` (the `HarnessStreamPart` union: `text-delta`, `tool-call`, `done`, …) or `await handle`.

```ts
const handle = runtime.run({ input: "Hello", sessionId: "demo-1", userId: "user-1" });
let reply = "";
for await (const part of handle.events) {
  if (part.type === "text-delta") reply += part.delta;
  if (part.type === "done") console.log("session:", part.sessionId);
}
await handle;
console.log(reply);
```

See `examples/02-hello-voice-headless/scripts/run-kuralle-full-text-smoke.ts` for a multi-turn harness over the full university agent.

---

## Give it knowledge (RAG)

Install `@kuralle-agents/rag` and optionally `@kuralle-agents/vectorize-store` on Cloudflare.

### Dev: in-memory store

Pattern from `examples/02-hello-voice-headless/src/university-agent-full.ts`:

```ts
import {
  AiSdkEmbedder,
  InMemoryVectorStore,
  VectorRetriever,
  createMarkdownChunker,
  createStaticKnowledgeSource,
} from "@kuralle-agents/rag";

const embedder = new AiSdkEmbedder({
  model: openai.embedding("text-embedding-3-small"),
});
const store = new InMemoryVectorStore();
await store.createIndex({ indexName: "university-kb", dimension: 1536 });

const chunker = createMarkdownChunker();
for (const doc of corpus) {
  const src = createStaticKnowledgeSource({ id: doc.id, name: doc.name, content: doc.content, chunker });
  const chunks = src.getChunks();
  const vecs = await embedder.embedMany(chunks.map((c) => c.text));
  await store.upsert(
    "university-kb",
    chunks.map((c, i) => ({
      id: `${doc.id}:${c.id}`,
      vector: vecs[i]!,
      document: c.text,
      metadata: { sourceId: doc.id },
    })),
  );
}

const retriever = new VectorRetriever({
  vectorStore: store,
  embedder,
  indexName: "university-kb",
  topK: 3,
});
```

`InMemoryVectorStore` is per-isolate — fine for local dev and smoke tests; re-ingest on cold start.

### Edge: Cloudflare Vectorize

From `packages/server-workers/src/kuralle-realtime-agent.ts`:

```ts
import { CloudflareVectorizeStore, type VectorizeBinding } from "@kuralle-agents/vectorize-store";

const store = new CloudflareVectorizeStore({ binding: env.VECTORIZE as unknown as VectorizeBinding });
const retriever = new VectorRetriever({
  vectorStore: store,
  embedder,
  indexName: "kuralle-university-kb",
  topK: 3,
});
```

Bind `VECTORIZE` in `packages/server-workers/wrangler.jsonc` (index name `kuralle-university-kb`).

### Wire retrieval into the runtime

```ts
const agent = defineAgent({
  id: "university",
  model,
  instructions: "You are a friendly university support assistant…",
  knowledge: { autoRetrieve: true }, // or false — see below
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: "university",
  sessionStore: new MemoryStore(),
  knowledge: { retriever, embedder },
});
```

### `autoRetrieve` — who retrieves? (ADR 0008)

From `@kuralle-agents/core` `types/grounding.d.ts`:

- **`autoRetrieve: true` (guaranteed)** — runtime pre-injects retrieved knowledge before every answering turn. Routing turns that still answer pay retrieval cost; grounding is guaranteed.
- **`autoRetrieve: false` (on-demand)** — runtime wires a `knowledge_search` tool; the model retrieves only when answering. Routing/dispatch turns pay **zero** retrieval tax.

They are mutually exclusive invokers (runtime vs model), not two modes you combine.

Flow `reply` nodes often set `grounding: { knowledge: { autoRetrieve: false } }` so procedural steps do not RAG mid-booking (`university-agent-full.ts`).

---

## Give it procedures (flows)

Flows are node graphs: `defineFlow({ name, description, start, nodes })` with node helpers `reply`, `collect`, `action`, `decide`, `confirmGate` from `@kuralle-agents/core`.

### Canonical pattern: `reply` + tools + `'stay'`

For **voice**, prefer one utterance per user turn. The pattern that works in production is a single `reply` node per phase with tools and a `next(turn, state)` that inspects `turn.toolResults` and returns `'stay'` until the user speaks again.

From `examples/02-hello-voice-headless/src/university-agent-full.ts` (booking flow):

```ts
import { defineFlow, defineTool, buildToolSet, reply } from "@kuralle-agents/core";
import { z } from "zod";

const recordBookingDetails = defineTool({
  name: "record_booking_details",
  description: "Record name, program, and preferred date once all three are known.",
  input: z.object({ name: z.string(), program: z.string(), preferredDate: z.string() }),
  execute: async (details) => details,
});

const createBookingTool = defineTool({
  name: "create_booking",
  description: "Finalize booking only after explicit user confirmation.",
  input: z.object({}),
  execute: async () => ({ bookingRef: `ADV-${++bookingCounter}` }),
});

const bookingTurn = reply({
  id: "book-advisor",
  grounding: { knowledge: { autoRetrieve: false } },
  instructions: ({ state }) => {
    if (state["bookingRef"]) {
      return `Confirm the booking; include reference ${String(state["bookingRef"])} verbatim.`;
    }
    if (state["name"] && state["program"] && state["preferredDate"]) {
      return `Summarize the appointment and ask for confirmation. Only after clear confirmation, call create_booking.`;
    }
    return `Help book an advisor appointment. When name, program, and date are present, call record_booking_details.`;
  },
  tools: buildToolSet({ record_booking_details: recordBookingDetails, create_booking: createBookingTool }),
  next: (turn, state) => {
    const booked = turn.toolResults.find((t) => t.name === "create_booking");
    if (booked?.result && typeof booked.result === "object") {
      Object.assign(state, booked.result);
      return { end: "booked" };
    }
    const recorded = turn.toolResults.find((t) => t.name === "record_booking_details");
    if (recorded?.result && typeof recorded.result === "object") {
      Object.assign(state, recorded.result);
    }
    return "stay";
  },
});

const bookingFlow = defineFlow({
  name: "book-advisor-appointment",
  description: "Book an appointment with an academic advisor",
  start: bookingTurn,
  nodes: [bookingTurn],
});
```

Attach flows on the agent: `defineAgent({ …, flows: [bookingFlow, transcriptFlow] })`.

### Pitfall: `collect` + `confirmGate` same-turn chaining

We hit a real bug using high-level `collect` + `confirmGate`: `confirmGate` consumed the **same** user message `collect` had already consumed, so bookings finalized before the user confirmed. Details in `kuralle-full-findings.md`. Until upstream fixes that, use the **`reply` + tools + `'stay'`** pattern above.

### Derived host routing (≥2 flows)

With two or more flows and no explicit router-only agent, kuralle folds flow entry into the answering turn (`enter_flow` tool) rather than a separate upfront classifier (ADR 0007). A **single** flow auto-enters without triage.

---

## Give it skills

Skills bundle procedural text the model loads on demand (Anthropic-style: name + description in prompt, body via `load_skill`).

From `examples/02-hello-voice-headless/src/university-agent-full.ts`:

```ts
import { defineSkill } from "@kuralle-agents/skills";

const SCHOLARSHIP_SKILL = defineSkill({
  name: "scholarship-guidance",
  description: "Guide students through scholarship eligibility and application steps",
  body: `# Scholarship Guidance
1. Ask whether the student wants merit-based, need-based, or both.
2. For merit: cite Dean's Merit Scholarship (GPA ≥ 3.5).
3. For need: cite Need-Based Grant (FAFSA required).
4. Always mention deadline February 15.`,
  allowedTools: [],
});

const agent = defineAgent({
  // …
  skills: [SCHOLARSHIP_SKILL],
});
```

`defineSkill` shape (`@kuralle-agents/core` `types/skills.d.ts`): `name` (kebab-case), `description`, `body`, optional `resources`, optional `allowedTools`.

For many skills, use `MemorySkillStore` from `@kuralle-agents/skills`:

```ts
import { MemorySkillStore } from "@kuralle-agents/skills";

const skillStore = new MemorySkillStore([SCHOLARSHIP_SKILL, /* … */]);
defineAgent({ skills: skillStore, /* … */ });
```

The runtime surfaces skills in the system prompt and exposes `load_skill`.

---

## Memory

Working memory holds markdown blocks (e.g. `USER`) loaded each session and updated via `memory_block`.

```ts
const agent = defineAgent({
  // …
  memory: {
    workingMemory: {
      autoLoad: [{ scope: "user", key: "USER" }],
    },
  },
});
```

### Stores

| Store | Package | When |
|-------|---------|------|
| `MemoryStore` | `@kuralle-agents/core` | In-process sessions (dev, single Node process). |
| `SqlPersistentMemoryStore` | `@kuralle-agents/cf-agent` | Cloudflare Durable Object SQLite — survives DO hibernation. |

Edge pattern (from `kuralle-bridge-manager-notes.md`, constructor in `@kuralle-agents/cf-agent`):

```ts
import { SqlPersistentMemoryStore } from "@kuralle-agents/cf-agent";

createRuntime({
  agents: [agent],
  defaultAgentId: "university",
  sessionStore: new MemoryStore(), // or DO-backed SessionStore
  defaultWorkingMemoryStore: new SqlPersistentMemoryStore(ctx.storage.sql),
  knowledge: { retriever, embedder },
});
```

Multi-turn recall is proven in `examples/02-hello-voice-headless/scripts/run-kuralle-memory-smoke.ts`: turn 1 states name and program; turn 2 asks "what's my name?" — kuralle answers from session memory keyed by `sessionId` + `userId`.

---

## Make it talk (cascade bridge)

Now connect kuralle to Syrinx. The adapter is **`fromKuralleRuntime(runtime, { sessionId, userId?, agentId? })`** → `Reasoner` (`packages/kuralle/src/from-kuralle.ts`). It calls `runtime.run({ input, sessionId, … })`, maps `handle.events` → `ReasoningPart`, and **ignores `turn.messages`** — kuralle owns history via `sessionId`.

Full cascade from `examples/02-hello-voice-headless/src/university-support-kuralle.ts`:

```ts
import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { PipecatEOSPlugin } from "@kuralle-syrinx/pipecat-smart-turn";
import { SileroVADPlugin } from "@kuralle-syrinx/silero-vad";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";

const runtime = createRuntime({ /* agent + sessionStore */ });

const session = new VoiceAgentSession({
  plugins: { /* stt, vad, eos, bridge, tts config */ },
  endpointingOwner: "smart_turn",
});

session.registerPlugin("stt", new DeepgramSTTPlugin());
session.registerPlugin("vad", new SileroVADPlugin());
session.registerPlugin("eos", new PipecatEOSPlugin());
session.registerPlugin(
  "bridge",
  new ReasoningBridge(
    fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, {
      sessionId: options.sessionId,
      userId: options.userId,
    }),
  ),
);
session.registerPlugin("tts", new CartesiaTTSPlugin());
```

Pipeline: **mic → Deepgram STT → smart-turn EOS → `ReasoningBridge(fromKuralleRuntime(…))` → Cartesia TTS → speaker**.

`createFullUniversityRuntime()` + the same bridge pattern is exercised in `examples/02-hello-voice-headless/scripts/run-kuralle-cascade-clean.ts`.

On barge-in, Syrinx truncates **its** bridge history to the spoken prefix; kuralle may have persisted the full assistant turn — reconcile before production (`packages/kuralle/src/from-kuralle.ts` exports `reconcileSpokenPrefix` for abort paths).

### Sharpen the cascade (turn-taking + latency)

Four production levers, adopted from what the field converged on (LiveKit preemptive
generation, Deepgram Flux, Sierra's latency playbook):

- **Semantic end-of-turn on the edge — `DeepgramFluxSTTPlugin`** (`@kuralle-syrinx/deepgram`).
  Flux is turn-aware STT: one model produces transcripts *and* decides when the turn is over,
  replacing silence endpointing. It is a plain WebSocket, so it runs on Workers, where
  smart-turn's ONNX cannot. Swap it in for `DeepgramSTTPlugin` (no `vad`/`eos` plugins needed):
  config `eot_threshold` (0.7), `eot_timeout_ms` (5000), and `eager_eot_threshold` (unset; see
  below).
- **Speculative generation — `new ReasoningBridge(reasoner, { speculative: true })`** (or
  `speculative: true` on a cf-agents cascaded pipeline). With Flux's `eager_eot_threshold` set
  (0.3–0.5), the bridge starts the LLM on the eager end-of-turn signal and holds every effect
  back; when the endpoint confirms the same transcript the draft commits as-is — the LLM's
  time-to-first-token ran *during* the endpoint confirmation window instead of after it
  (Deepgram measures the eager signal 150–250ms early). Wrong guesses are discarded and
  regenerated. Opt-in: unconfirmed endpoints cost extra LLM calls (+50–70%).
- **Keyterm biasing — `keyterm: ["YourProduct", "Kuralle"]`** on either Deepgram STT plugin.
  Mishearing names/codes is the #1 production voice-agent failure (Sierra's data); bias the
  recognizer toward your domain terms.
- **Honest per-turn latency — the `turn_latency` session event**:
  `{ ttfaMs, eouDelayMs?, llmTtftMs?, ttsTtfbMs?, fillerUsed }` once per assistant turn,
  anchored to the real end of user speech. `fillerUsed` flags turns where a latency filler
  spoke first, so a masked turn is never mistaken for a fast one. This is the LiveKit-style
  decomposition (`e2e = EOU delay + LLM TTFT + TTS TTFB`) — wire it to your metrics sink and
  optimize the term that dominates.

---

## Make it feel instant (bi-model)

Cascade latency is often dominated by kuralle (RAG + tools + flow steps). **Bi-model** keeps a realtime **front** model on the audio loop and delegates factual work to kuralle via a tool.

From `examples/02-hello-voice-headless/scripts/run-realtime-kuralle-bimodel-smoke.ts`:

```ts
import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

const ASK_UNIVERSITY_TOOL = {
  name: "ask_university",
  description: "Answer university student-relations questions.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const adapter = fromOpenAIRealtime({
  apiKey: process.env.OPENAI_API_KEY!,
  socketFactory: createNodeWsSocket,
  turnDetection: { type: "server_vad", silence_duration_ms: 500 },
  tools: [ASK_UNIVERSITY_TOOL],
});

const { runtime } = await createFullUniversityRuntime();
const universityReasoner = fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, {
  sessionId: `bimodel-${crypto.randomUUID()}`,
  userId: "bimodel",
});

const bridge = new RealtimeBridge(adapter, universityReasoner, ASK_UNIVERSITY_TOOL.name);

const session = new VoiceAgentSession({
  plugins: { realtime: {} },
  endpointingOwner: "timer", // front model owns turn detection — no STT/VAD/TTS plugins
});
session.registerPlugin("realtime", bridge);
```

`RealtimeBridge` constructor (`packages/realtime/src/realtime-bridge.ts`):

```ts
new RealtimeBridge(adapter, reasoner?, delegateToolName = "consult_knowledge", opts?)
```

- **Standalone:** `new RealtimeBridge(adapter)` — pure speech-to-speech.
- **Bi-model:** pass kuralle (or any `Reasoner`) as the second arg and the delegate tool name as the third.

### Gemini Live front

`fromGeminiLive(opts)` (`packages/realtime/src/from-gemini-live.ts`) — same `RealtimeBridge` wiring; options include `apiKey`, `model?`, `systemInstruction?`, `tools?`, `sessionResumptionHandle?`. Cloudflare example: `packages/server-workers/src/live-realtime-session.ts` (env `REALTIME_FRONT=gemini`).

### The Responder-Thinker primitive (what the delegate seam gives you)

This bi-model shape has a name — **Responder-Thinker**: the realtime front is the *responder* (presence, speech, turn-taking), the `Reasoner` is the *thinker* (facts, RAG, tools). Nobody else packages it turnkey; Syrinx's delegate seam ships four behaviors so you don't hand-roll them (RFC `docs/rfc-bimodel-delegate-seam.md`):

1. **Faithful voicing (envelope, default).** The thinker's answer is injected as `{ "response_text": "...", "require_repeat_verbatim": true }` (plus an optional `render` directive) — the shape OpenAI's Realtime prompting guide validates for anti-paraphrase tool output. Your front prompt keys on `response_text` being the authoritative answer. Opt out with `toolResultFormat: "string"`.
2. **Observability.** Every delegate run emits `delegate.query` → `delegate.result` bus packets (query, answer, `durationMs`, `grounded`); `withVoice` exposes them as `onDelegateQuery` / `onDelegateResult` hooks. No more wrapping the `Reasoner` to log.
3. **"Thinking" cues.** The engine emits a typed tool-call lifecycle — `tool_call_started` / `tool_call_delayed` / `tool_call_complete` / `tool_call_failed` — over the wire, wrapping the thinker-latency window (started fires *before* the thinker runs; delayed is the time-triggered "still working"; failed covers errors, barge-in, and superseded turns). Key client earcons/indicators on these.
4. **Durable resume.** With `withVoice` the conversation survives Durable Object eviction: the thinker re-seeds from DO-SQLite (`ReasonerSessionStore`), and the front resumes per provider capability — OpenAI replays the transcript (`resumeHistory`, `conversation.item.create`, never a `response.create`), Gemini passes its native `sessionResumption` handle through (`ctx.resume.providerHandle`) with no replay.

---

## All the bridges

Syrinx normalizes every reasoning backend to either a **`Reasoner`** (cascade) or a **`RealtimeAdapter`** (bi-model / translate).

| Bridge | Package | Signature | When to use |
|--------|---------|-----------|-------------|
| `fromKuralleRuntime` | `@kuralle-syrinx/kuralle` | `(runtime, { sessionId, userId?, agentId? }) → Reasoner` | Kuralle agent is the brain; session history via `sessionId`. |
| `fromAiSdkAgent` | `@kuralle-syrinx/aisdk` | `(agent: AiSdkAgentLike) → Reasoner` | Vercel AI SDK agent with `.stream({ messages, abortSignal })`. |
| `fromStreamText` | `@kuralle-syrinx/aisdk` | `(config: StreamTextConfig) → Reasoner` | Raw `streamText({ model, system, tools, … })` config. |
| `fromStreamFactory` | `@kuralle-syrinx/aisdk` | `(factory: AISDKStreamFactory) → Reasoner` | Custom async generator of `TextStreamPart` (tests/custom). |
| `fromMastraAgent` | `@kuralle-syrinx/mastra` | `(agent: MastraAgentLike) → Reasoner` | Mastra `Agent` with `stream` / `resumeStream`. |
| `fromOpenAIRealtime` | `@kuralle-syrinx/realtime` | `(opts: OpenAIRealtimeOptions) → RealtimeAdapter` | gpt-realtime front; bi-model or standalone s2s. |
| `fromGeminiLive` | `@kuralle-syrinx/realtime` | `(opts: GeminiLiveOptions) → RealtimeAdapter` | Gemini Live front; bi-model or standalone s2s. |
| `createGeminiTranslateSession` | `@kuralle-syrinx/realtime` | `(opts: GeminiTranslateSessionOptions) → Promise<GeminiTranslateSession>` | Speech-to-speech **translation** passthrough (no Reasoner). |

Cascade plugins:

- **`ReasoningBridge`** (`@kuralle-syrinx/aisdk`) — drives any `Reasoner` on `eos.turn_complete`.
- **`RealtimeBridge`** (`@kuralle-syrinx/realtime`) — drives any `RealtimeAdapter`; optional delegate `Reasoner`.

<details>
<summary><code>fromKuralleRuntime</code> — kuralle as Reasoner</summary>

```ts
import { fromKuralleRuntime } from "@kuralle-syrinx/kuralle";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";

const reasoner = fromKuralleRuntime(runtime, { sessionId: "conv-1", userId: "u-1" });
session.registerPlugin("bridge", new ReasoningBridge(reasoner));
```

Maps kuralle `text-delta`, `tool-call`, `tool-result`, `paused`/`interactive` → `suspended`, `done` → `finish`. See `packages/kuralle/README.md`.

</details>

<details>
<summary><code>fromAiSdkAgent</code> / <code>fromStreamText</code> — Vercel AI SDK</summary>

```ts
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";
import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs } from "ai";

const bridge = new ReasoningBridge(fromStreamText({
  model: createOpenAI({ apiKey })("gpt-4.1-mini"),
  system: "You are a helpful voice assistant.",
  temperature: 0.4,
  maxOutputTokens: 256,
  stopWhen: stepCountIs(1),
}));
```

`fromAiSdkAgent` wraps an object with `stream({ messages, abortSignal }) → { fullStream }`. See `packages/aisdk/src/from-ai-sdk.ts`.

</details>

<details>
<summary><code>fromMastraAgent</code> — Mastra Agent</summary>

```ts
import { fromMastraAgent } from "@kuralle-syrinx/mastra";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";

session.registerPlugin("bridge", new ReasoningBridge(fromMastraAgent(mastraAgent)));
```

Supports `turn.resume` → `agent.resumeStream`. Peer: `@mastra/core`. See `packages/mastra/README.md`.

</details>

<details>
<summary><code>fromOpenAIRealtime</code> — gpt-realtime bi-model front</summary>

```ts
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

const adapter = fromOpenAIRealtime({
  apiKey,
  socketFactory: createNodeWsSocket,
  model: "gpt-realtime-2", // default
  voice: "marin",            // default
  tools: [delegateToolDef],
  turnDetection: { type: "semantic_vad" },
});
session.registerPlugin("realtime", new RealtimeBridge(adapter, reasoner, "ask_university"));
```

Requires `socketFactory` from `@kuralle-syrinx/ws` (Node: `createNodeWsSocket`; Workers: `createWorkersSocket`). See `packages/realtime/src/from-openai-realtime.ts`.

</details>

<details>
<summary><code>fromGeminiLive</code> — Gemini Live bi-model front</summary>

```ts
import { RealtimeBridge, fromGeminiLive } from "@kuralle-syrinx/realtime";

const adapter = fromGeminiLive({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-3.1-flash-live-preview", // default in source
  systemInstruction: "You are a university voice assistant.",
  tools: [delegateToolDef],
});
session.registerPlugin("realtime", new RealtimeBridge(adapter, reasoner, "ask_university"));
```

Input 16 kHz / output 24 kHz per adapter caps. `supportsConcurrentToolAudio: false` — delegate calls block front audio. See `packages/realtime/src/from-gemini-live.ts`.

</details>

<details>
<summary><code>createGeminiTranslateSession</code> — translation passthrough</summary>

No Reasoner — direct speech-to-speech translation:

```ts
import { createGeminiTranslateSession } from "@kuralle-syrinx/realtime";

const session = await createGeminiTranslateSession({
  apiKey: process.env.GEMINI_API_KEY!,
  targetLanguageCode: "es",
  echoTargetLanguage: true,
  onAudio: (pcm16, sampleRateHz) => { /* play out */ },
  onText: (text, role, final) => { /* transcript */ },
});

session.sendAudio(pcm16Chunk);
session.signalAudioStreamEnd();
await session.close();
```

**~100 ms input chunks:** Gemini Live Translate expects ~100 ms PCM16 @ 16 kHz (3200 bytes). The session coalesces smaller frames internally (`packages/realtime/src/gemini-translate.ts`). Callers can keep sending 20 ms engine frames.

</details>

---

## Ship it: Node, then Cloudflare

### Environment

Syrinx reads provider keys from `.env` (gitignored). From the repo README:

```
OPENAI_API_KEY=
GEMINI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
DEEPGRAM_API_KEY=
CARTESIA_API_KEY=
CARTESIA_VOICE_ID=
```

Wire protocol: `docs/websocket-audio-protocol.md`.

### Node: WebSocket server

`@kuralle-syrinx/server-websocket` exposes `createVoiceWebSocketServer(options)` (`packages/server-websocket/src/index.ts`). Minimal shape from `examples/02-hello-voice-headless/scripts/serve-websocket-review-studio.ts`:

```ts
import { createServer } from "node:http";
import { createVoiceWebSocketServer, installGracefulShutdown } from "@kuralle-syrinx/server-websocket";
import { createUniversitySupportKuralleSession } from "./university-support-kuralle.js";

const httpServer = createServer(/* static UI or healthz */);
const voiceServer = await createVoiceWebSocketServer({
  server: httpServer,
  port: 8787,
  host: "127.0.0.1",
  path: "/ws",
  createSession: () =>
    createUniversitySupportKuralleSession({
      sessionId: crypto.randomUUID(),
      inputSampleRate: 16000,
      profile: "interactive",
      ttsProvider: "cartesia",
    }),
});
// Client connects: ws://127.0.0.1:8787/ws
installGracefulShutdown(voiceServer);
```

Point [Syrinx Studio](https://syrinx-studio.mithushancj.workers.dev) at `wss://<your-host>/ws?sessionId=<id>` with the `?ws=` switcher (README Playground section).

**Security:** voice `/ws` endpoints are unauthenticated by default — add auth before exposing publicly.

### Cloudflare Workers: cascade

`@kuralle-syrinx/server-workers` — one Durable Object per conversation.

```bash
pnpm --filter @kuralle-syrinx/server-workers exec wrangler deploy
# secrets:
wrangler secret put DEEPGRAM_API_KEY
wrangler secret put OPENAI_API_KEY
```

- Config: `packages/server-workers/wrangler.jsonc` — `VECTORIZE` binding, optional `RECORDINGS` R2.
- Entry: `packages/server-workers/src/worker.ts` — `wss://<your-worker>/ws?sessionId=<id>`.
- Session: `createLiveVoiceAgentSession` — Deepgram STT + `ReasoningBridge(createRealtimeKuralleReasoner(…))` + Deepgram TTS (`packages/server-workers/src/live-session.ts`).

Health: `GET /health`. Recordings: `GET /recordings?sessionId=<id>` when R2 is bound.

### Cloudflare Workers: realtime bi-model

```bash
pnpm --filter @kuralle-syrinx/server-workers run deploy:realtime
# uses wrangler.realtime.jsonc
```

- Entry: `packages/server-workers/src/worker-realtime.ts`.
- Session: `createRealtimeVoiceAgentSession` — `fromOpenAIRealtime` or `fromGeminiLive` + `RealtimeBridge` + kuralle Vectorize reasoner (`packages/server-workers/src/live-realtime-session.ts`).
- Set `REALTIME_FRONT=gemini` and `GEMINI_API_KEY` for Gemini Live front.

Use `wss://<your-worker>/ws?sessionId=<id>` — never paste live playground hostnames into your own deployments.

---

## Gotchas we learned

### Flow authoring

- Prefer **`reply` + tools + `'stay'`** over `collect` + `confirmGate` chains for multi-turn voice until same-turn input consumption is fixed (`kuralle-full-findings.md`).
- Avoid `{ goto: nextNode }` chains that make **multiple nodes speak in one turn** — fine for text smoke, awkward for TTS (one utterance per turn is the voice budget).
- Set `grounding.knowledge.autoRetrieve: false` on flow nodes so booking steps do not pay RAG tax.

### `autoRetrieve` on routing turns

With `autoRetrieve: true`, flow-entry turns may embed and query the vector store even when the turn only routes into a flow — wasted retrieval (`kuralle-full-findings.md`). Consider `autoRetrieve: false` at the agent level plus on-demand `knowledge_search`, or per-node overrides.

### OpenAI prompt cache ≥1024 tokens

OpenAI's automatic prefix cache only helps when the stable prompt prefix is **≥1024 tokens** (`kuralle-prompt-cache-finding.md`). Small university agents often sit under that threshold and cache nothing. Provider `promptCacheKey` wiring in kuralle-core is not exported by default as of 0.7.1 — expect full input cost on short agents until wired upstream.

### Gemini translate chunk size

`createGeminiTranslateSession` coalesces to **100 ms** @ 16 kHz (3200 bytes). Feeding sparse 20 ms frames without coalescing can make the model echo the source language instead of translating (`packages/realtime/src/gemini-translate.ts`).

### Kuralle history vs Syrinx barge-in

`fromKuralleRuntime` ignores `turn.messages`; kuralle persists full turns by `sessionId`. On interrupt, Syrinx rewrites bridge history to the spoken prefix — kuralle may still hold the full reply. Use `reconcileSpokenPrefix` on abort paths or accept divergence until you unify reconciliation.

### Bi-model delegate latency

The front model can speak a lead-in while kuralle runs RAG/tools — measured delegate latency ~4s in university smokes, often hidden under lead-in audio (`packages/realtime/README.md`, `run-realtime-kuralle-bimodel-smoke.ts`).

---

## Next steps

- Run text harness: `pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless run smoke:kuralle-full-text`
- Run cascade voice: `smoke:kuralle-cascade-clean`
- Run bi-model: `smoke:realtime-kuralle-bimodel`
- Run memory: `smoke:kuralle-memory`
- Local review UI: `review:studio` in the example package

For wire format and provider testing, see `docs/websocket-audio-protocol.md` and `PROVIDER-TESTING.md`.
