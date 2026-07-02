# @kuralle-syrinx/cf-agents

`withVoice(Agent, options)` — add a Syrinx voice pipeline to a Cloudflare
[`agents`](https://github.com/cloudflare/agents) SDK `Agent`. Supports both a
**realtime** front (Gemini Live / OpenAI Realtime) and a **cascaded**
STT → reasoner → TTS pipeline.

It is a mixin **over** the `Agent`, not a raw Durable Object: it reuses the
Agent's native hibernation, `keepAlive()` lease, `Connection`, and SQL, and hands
each connection to Syrinx's published edge runner
(`runVoiceEdgeWebSocketConnection`) wrapped as a `ManagedSocket`. When the Agent
exposes a public kuralle `runtime`, it is the brain by default
(`fromKuralleRuntime(this.runtime)`); otherwise pass `reasoner` explicitly.

`agents` is a **peer dependency** — install it alongside this package.

## Realtime

```ts
import { Agent, routeAgentRequest } from "agents";
import { withVoice } from "@kuralle-syrinx/cf-agents";
import { fromGeminiLive } from "@kuralle-syrinx/realtime";

export class SupportVoiceAgent extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: {
    kind: "realtime",
    front: (env) => fromGeminiLive({ apiKey: env.GEMINI_API_KEY, tools: [CONSULT] }),
    delegateToolName: "consult_knowledge",
  },
  // reasoner defaults to fromKuralleRuntime(this.runtime, { sessionId })
}) {}

export default {
  fetch: (request: Request, env: Env) =>
    routeAgentRequest(request, env).then((r) => r ?? new Response("Not found", { status: 404 })),
};
```

## Cascaded

```ts
import { withVoice } from "@kuralle-syrinx/cf-agents";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";

export class SupportVoiceAgent extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: {
    kind: "cascaded",
    stt: (env) => ({
      plugin: new DeepgramSTTPlugin(createWorkersSocket),
      config: { api_key: env.DEEPGRAM_API_KEY, model: "nova-3", sample_rate: 16000 },
    }),
    tts: (env) => ({
      plugin: new CartesiaTTSPlugin(createWorkersSocket),
      config: { api_key: env.CARTESIA_API_KEY, voice_id: env.CARTESIA_VOICE_ID, model_id: "sonic-3" },
    }),
    // optional: vad, eos (set endpointingOwner: "smart_turn" when supplying eos)
  },
  // reasoner defaults to fromKuralleRuntime(this.runtime); required for non-kuralle agents
}) {}
```

## The Responder-Thinker primitive

`withVoice` packages Syrinx's bi-model **Responder-Thinker** shape turnkey (RFC
`docs/rfc-bimodel-delegate-seam.md`): wire a realtime front + a `Reasoner` and the delegate seam
comes with —

- **Structured result envelope (G1, default).** The reasoner's answer reaches the front model as
  `{ response_text, require_repeat_verbatim: true, render? }` so it repeats facts faithfully
  instead of paraphrasing. Configure per pipeline: `toolResultFormat: "envelope" | "string"`,
  `renderDirective: "translate_faithfully"`.
- **Delegate observability (G2).** `onDelegateQuery` / `onDelegateResult` hooks fire around every
  reasoner run with the query, answer, `durationMs`, and `grounded` — log or persist the Q&A pair
  without wrapping the `Reasoner`.
- **Typed "thinking" cues (G3).** Clients automatically receive `tool_call_started` /
  `tool_call_delayed` (after `delayCueAfterMs`) / `tool_call_complete` / `tool_call_failed` wire
  messages around the reasoner-latency window — key earcons/indicators on these instead of
  inventing an app message (`@kuralle-syrinx/browser-client` parses them).
- **Durable session + resume (G4, default on).** The conversation persists to the Agent's
  DO-SQLite and survives eviction/hibernation: cascaded pipelines re-seed the `ReasoningBridge`;
  realtime pipelines feed the durable transcript to delegate turns and expose `ctx.resume` to the
  `front()` factory — `resumeHistory: ctx.resume.history` on replay providers (OpenAI),
  `sessionResumptionHandle: ctx.resume.providerHandle` on native-resume providers (Gemini; never
  replay on top of a handle).

## Options

| Option | Description |
| --- | --- |
| `transport` | `"edge"` (default — Syrinx browser/edge protocol over `/ws`) or `"twilio"` (Twilio Media Streams, μ-law 8 kHz, for a PSTN leg). One transport per Agent class. |
| `pipeline` | `{ kind: "realtime", front, delegateToolName?, toolResultFormat?, renderDirective? }` or `{ kind: "cascaded", stt, tts, vad?, eos?, endpointingOwner?, sttForceFinalizeTimeoutMs? }`. |
| `reasoner` | `(env, ctx) => Reasoner` (ctx: `{ sessionId, resume? }`). Defaults to `fromKuralleRuntime(this.runtime)` when the Agent exposes a kuralle `runtime`. Required for cascaded agents without one. |
| `recorder` | `(env, { sessionId }) => EdgeRecorder \| undefined` — optional per-call recorder (e.g. the R2 recorder at `@kuralle-syrinx/cf-agents/r2-recorder`). Edge transport. |
| `onToolCallStart` | `(ctx: { toolName, args, sessionId, connection }) => void \| Promise<void>` — fired the instant the front model invokes the delegate tool, **before** the reasoner runs — for app-specific cues beyond the standard `tool_call_*` wire messages. A throwing callback never affects the call. |
| `onDelegateQuery` / `onDelegateResult` | G2 observability hooks around the reasoner run. `onDelegateResult` is self-contained (`{ query, answer, durationMs, grounded, toolId?, toolName?, turnId, sessionId, connection }`) — the one hook for logging/persisting grounded Q&A pairs. Throwing never affects the call. |
| `durableHistory` | G4 durable session state over the Agent's SQLite (default `true`). Set `false` for ephemeral pre-G4 behavior. |
| `delayCueAfterMs` | G3: ms before a pending tool call fires the `tool_call_delayed` ("still working") cue. 0 disables. Default 2000. |
| `inputSampleRateHz` / `outputSampleRateHz` | Edge audio rates (default 16000). |
| `resumeWindowMs` | How long a dropped connection can resume its session. |
| `sessionId` | `(request, agentName) => string`. Defaults to the `?sessionId=` query param (so a reconnecting client can resume), else a per-connection random id. (Not the Agent name — concurrent connections to one instance must not share a session.) |

The client speaks Syrinx's edge voice protocol — connect a
`@kuralle-syrinx/browser-client` to
`wss://<worker>/agents/<agent-class-kebab>/<instance>`.

See [`examples/03-cf-agent-voice`](../../examples/03-cf-agent-voice) for a runnable worker.
