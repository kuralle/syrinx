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

## Options

| Option | Description |
| --- | --- |
| `transport` | `"edge"` (default — Syrinx browser/edge protocol over `/ws`) or `"twilio"` (Twilio Media Streams, μ-law 8 kHz, for a PSTN leg). One transport per Agent class. |
| `pipeline` | `{ kind: "realtime", front, delegateToolName? }` or `{ kind: "cascaded", stt, tts, vad?, eos?, endpointingOwner?, sttForceFinalizeTimeoutMs? }`. |
| `reasoner` | `(env, { sessionId }) => Reasoner`. Defaults to `fromKuralleRuntime(this.runtime)` when the Agent exposes a kuralle `runtime`. Required for cascaded agents without one. |
| `recorder` | `(env, { sessionId }) => EdgeRecorder \| undefined` — optional per-call recorder (e.g. the R2 recorder at `@kuralle-syrinx/cf-agents/r2-recorder`). Edge transport. |
| `onToolCallStart` | `(ctx: { toolName, args, sessionId, connection }) => void \| Promise<void>` — fired the instant the front model invokes the delegate tool, **before** the reasoner runs. The seam for a deterministic latency-masking preamble / "thinking" earcon: `ctx.connection.send(...)` to trigger a cached client-side cue. A throwing callback never affects the call. |
| `inputSampleRateHz` / `outputSampleRateHz` | Edge audio rates (default 16000). |
| `resumeWindowMs` | How long a dropped connection can resume its session. |
| `sessionId` | `(request, agentName) => string`. Defaults to the `?sessionId=` query param (so a reconnecting client can resume), else a per-connection random id. (Not the Agent name — concurrent connections to one instance must not share a session.) |

The client speaks Syrinx's edge voice protocol — connect a
`@kuralle-syrinx/browser-client` to
`wss://<worker>/agents/<agent-class-kebab>/<instance>`.

See [`examples/03-cf-agent-voice`](../../examples/03-cf-agent-voice) for a runnable worker.
