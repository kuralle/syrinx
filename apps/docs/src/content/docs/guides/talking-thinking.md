---
title: The talking–thinking model
description: A fast realtime voice front that talks while a background reasoner does the deep thinking — wired through one delegate tool.
---

A realtime speech-to-speech model is fast and expressive, but shallow: it improvises, it doesn't retrieve, and it will happily invent a fact to keep the conversation flowing. A reasoner — your RAG agent, your tool-using LLM — is grounded and deep, but too slow to *be* the voice.

The **talking–thinking model** (also called responder–thinker, or bi-model) gives you both. A fast realtime model does the **talking** — it greets, handles small talk, keeps the line warm. When a turn actually needs grounded knowledge, it delegates to a background reasoner that does the **thinking**, and speaks the answer back. The caller only ever hears the front; the thinker never touches the microphone.

```
caller ⇄ realtime front (the talker) ──consult_knowledge──▶ reasoner (the thinker)
                    ▲                                              │
                    └──────────── grounded answer ◀───────────────┘
```

## The three pieces

- **The talker** — a realtime adapter (`fromOpenAIRealtime` / `fromGeminiLive`) that advertises a single **delegate tool**. The front decides, per turn, whether to answer directly or call the tool.
- **The thinker** — any Syrinx `Reasoner`. A plain AI-SDK model, a Mastra agent, or a kuralle RAG runtime — anything that turns a question into a grounded answer.
- **The bridge** — `RealtimeBridge` wires the two together. When the front calls the delegate tool, the bridge routes the query to the reasoner, then injects the answer back into the front as an authoritative tool result.

## Wire it up

```ts
import { VoiceAgentSession } from '@kuralle-syrinx/core';
import { RealtimeBridge, fromOpenAIRealtime, type RealtimeToolDef } from '@kuralle-syrinx/realtime';
import { fromStreamText } from '@kuralle-syrinx/aisdk';
import { createNodeWsSocket } from '@kuralle-syrinx/ws/node';
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

// The tool the front advertises. When the front decides a turn needs grounded
// knowledge, it calls this — and the bridge routes the query to the thinker.
const CONSULT_TOOL: RealtimeToolDef = {
  name: 'consult_knowledge',
  description:
    'Look up grounded, factual answers. Call this for real questions; answer greetings and small talk directly.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: "The user's question, self-contained." } },
    required: ['query'],
  },
};

// The thinker: a deep reasoner. AI SDK here; swap for a kuralle RAG agent or Mastra.
const thinker = fromStreamText({
  model: openai('gpt-4.1'),
  system: "Answer the user's question with grounded facts. Be concise.",
});

// The talker: a realtime front that advertises the consult tool.
const front = fromOpenAIRealtime({
  apiKey: process.env.OPENAI_API_KEY!,
  socketFactory: createNodeWsSocket,
  tools: [CONSULT_TOOL],
});

const session = new VoiceAgentSession({
  plugins: { realtime: {} },
  endpointingOwner: 'timer', // the realtime front owns its own turn detection
});

// The bridge delegates CONSULT_TOOL calls to the thinker.
session.registerPlugin('realtime', new RealtimeBridge(front, thinker, CONSULT_TOOL.name));

await session.start();
```

That's the whole pattern. `new RealtimeBridge(front, thinker, CONSULT_TOOL.name)` — front, reasoner, and the tool name that means *"delegate this to the thinker."* Any tool call the front makes with that name is routed to the reasoner; any other tool call is yours to handle (see `onFrontToolCall` below).

:::tip
This is a runnable file — [`talking-thinking.ts`](https://github.com/kuralle/syrinx/blob/main/examples/02-hello-voice-headless/src/talking-thinking.ts). It needs only `OPENAI_API_KEY`, feeds itself a WAV fixture, and prints whether the front delegated to the thinker:

```bash
pnpm -C examples/02-hello-voice-headless exec tsx src/talking-thinking.ts
```
:::

## Proactivity lives in the front's prompt

The front is a live model, so it's proactive by default — it greets first, matches the caller's language, and keeps the conversation moving. The one thing you steer is *when it consults*. That's a prompt job, not a code job:

```ts
const front = fromOpenAIRealtime({
  apiKey: process.env.OPENAI_API_KEY!,
  socketFactory: createNodeWsSocket,
  instructions: `You are a warm, concise phone assistant. Greet the caller first.
Answer greetings, chit-chat, and clarifying questions yourself, immediately.
For any real question about facts, policy, or specifics, call consult_knowledge
with a self-contained query, then speak the answer you get back verbatim.
Never invent facts — if it needs knowledge, consult.`,
  tools: [CONSULT_TOOL],
});
```

This split is what keeps latency low: the front handles the cheap, frequent turns instantly, and only pays the reasoner's round-trip on the turns that genuinely need it.

## The front speaks the thinker's answer faithfully

When the reasoner returns, the bridge doesn't hand the front a loose string to paraphrase — it wraps the answer in an authoritative envelope (`response_text` + `require_repeat_verbatim`) before `injectToolResult`. The front treats it as ground truth and repeats it, instead of "improving" it or drifting off the facts. This is `toolResultFormat: 'envelope'`, the default; pass `'string'` to inject the raw answer instead. The wrapping is a synchronous `JSON.stringify` on the already-buffered answer — it adds no latency.

## Render a "thinking…" indicator

A reasoner turn can take a second or two. The session emits a `tool_call_cue` event through that window so your UI can show a thinking state — and, crucially, only shows it when the thinker is *actually* slow:

```ts
session.on('tool_call_cue', (cue) => {
  switch (cue.phase) {
    case 'started':  break;                       // the front called the delegate tool
    case 'delayed':  showThinkingIndicator();     // still pending after delayCueAfterMs
    case 'complete': hideThinkingIndicator();     // the answer came back
    case 'failed':   hideThinkingIndicator();     // the reasoner errored
  }
});
```

The `delayed` phase fires only if the call is still pending after `delayCueAfterMs` (default **2000ms**, set it in the session config; `0` disables the cue). So a fast consult never flashes a spinner — the indicator appears only when the caller would otherwise wonder if the line went dead. Reach for a longer window on a snappy reasoner, a shorter one when you want an earcon on every consult.

If you'd rather the *assistant* fill the gap with a spoken connective ("Let me check that…") instead of a client-rendered indicator, enable the `LatencyFillerController` — it speaks a short filler at the endpoint. The two are independent: an event for your UI, or an utterance for the caller.

## On Cloudflare Workers

The same pattern runs on the [Workers edge](/guides/deploy-on-cloudflare/) through `withVoice`. You declare a `realtime` pipeline with a `delegateToolName` and a `reasoner`; the mixin builds the bridge for you inside a hibernatable Durable Object:

```ts
import { Agent } from 'agents';
import { withVoice } from '@kuralle-syrinx/cf-agents';
import { fromOpenAIRealtime } from '@kuralle-syrinx/realtime';
import { createWorkersSocket } from '@kuralle-syrinx/ws/workers';

export class VoiceSession extends withVoice(Agent<Env>, {
  pipeline: {
    kind: 'realtime',
    front: (env) => fromOpenAIRealtime({
      apiKey: env.OPENAI_API_KEY,
      socketFactory: createWorkersSocket,
      instructions: FRONT_PROMPT,
      tools: [CONSULT_TOOL],
    }),
    delegateToolName: CONSULT_TOOL.name,
  },
  // The thinker — any Reasoner. Here a kuralle RAG runtime.
  reasoner: (env, ctx) => buildReasoner(env, ctx),

  // Fires the instant the front calls the delegate tool, BEFORE the reasoner runs —
  // push a "thinking" earcon to the client without waiting on the model to speak one.
  onDelegateQuery: (ctx) => ctx.connection.send(JSON.stringify({ type: 'thinking' })),
}) {}
```

`onDelegateQuery` fires before the reasoner starts, and `onDelegateResult` fires when the grounded answer is ready — the seam for driving a client-side thinking indicator or logging every consult. Under load, each conversation is one Durable Object; the front and the thinker share it.

## Swap the thinker

The thinker is just a `Reasoner`, so the whole deep half of the agent is pluggable without touching the front:

- **`fromStreamText`** (`@kuralle-syrinx/aisdk`) — any Vercel AI SDK model, with your own tools.
- **`fromMastraAgent`** (`@kuralle-syrinx/mastra`) — a Mastra agent, memory and workflows included.
- **`fromKuralleRuntime`** (`@kuralle-syrinx/kuralle`) — a kuralle RAG runtime, for retrieval-grounded answers.

Point `RealtimeBridge`'s second argument at a different reasoner and the front is unchanged — it still calls `consult_knowledge`, it just reaches a different brain.

## Handle the front's own tools

Not every tool call is a delegation. If your front also exposes tools it should handle itself — `escalate_to_human`, `end_call`, `send_sms` — give the bridge an `onFrontToolCall` so those don't hit the reasoner:

```ts
new RealtimeBridge(front, thinker, CONSULT_TOOL.name, {
  onFrontToolCall: ({ toolName, args }) => {
    if (toolName === 'end_call') { hangUp(); return 'Call ended.'; }
    return undefined; // fall through
  },
});
```

Only calls named `consult_knowledge` (the delegate tool) reach the thinker; everything else is yours.

## Next

- [Build a voice agent](/guides/building-a-voice-agent/) — the cascade pipeline, for comparison.
- [Realtime providers](/providers/realtime/) — the front adapters and their options.
- [Deploy on Cloudflare](/guides/deploy-on-cloudflare/) — the Workers runtime this runs on.
