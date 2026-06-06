# @kuralle-syrinx/grok

xAI Grok voice provider for Syrinx — streaming STT, streaming TTS, and speech-to-speech realtime.

## Install

```bash
pnpm add @kuralle-syrinx/grok
```

## Auth

Pass `apiKey` in plugin config or adapter options. For local smokes, set `XAI_API_KEY` in the repo-root `.env`.

## Streaming STT — `GrokSTTPlugin`

```typescript
import { GrokSTTPlugin } from "@kuralle-syrinx/grok/stt";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

const stt = new GrokSTTPlugin(createNodeWsSocket);
await stt.initialize(bus, {
  api_key: process.env.XAI_API_KEY!,
  language: "en",
  sample_rate: 16000,
});
```

Connects to `wss://api.x.ai/v1/stt` with query-param config. Sends raw PCM16 frames after `transcript.created`, then `{"type":"audio.done"}` on finalize/shutdown. Emits `stt.interim`, `stt.result`, and `eos.turn_complete` (when `speech_final`).

## Streaming TTS — `GrokTTSPlugin`

```typescript
import { GrokTTSPlugin } from "@kuralle-syrinx/grok/tts";

const tts = new GrokTTSPlugin(createNodeWsSocket);
await tts.initialize(bus, {
  api_key: process.env.XAI_API_KEY!,
  voice_id: "eve",
  sample_rate: 16000,
});
```

Connects to `wss://api.x.ai/v1/tts?codec=pcm&sample_rate=16000`. Consumes `tts.text` / `tts.done`, emits `tts.audio` + `tts.end`. Uses `text.delta` / `text.done` / `text.clear` on the wire.

## Realtime S2S — `fromGrokRealtime`

```typescript
import { fromGrokRealtime } from "@kuralle-syrinx/grok/realtime";
import { RealtimeBridge } from "@kuralle-syrinx/realtime";

const adapter = fromGrokRealtime({
  apiKey: process.env.XAI_API_KEY!,
  socketFactory: createNodeWsSocket,
  voice: "eve",
  turnDetection: { type: "server_vad" },
  tools: [/* caller-supplied RealtimeToolDef[] */],
});
const bridge = new RealtimeBridge(adapter);
```

OpenAI Realtime-compatible subset on `wss://api.x.ai/v1/realtime?model=grok-voice-latest`. Caps: `supportsTruncate: false`, `supportsConcurrentToolAudio: false`. Barge-in relies on client/kernel VAD plus `response.cancel` (no `speech_started` / truncate).

## Deploy on Cloudflare Workers

`@kuralle-syrinx/grok` is **edge-clean**: no `Buffer`, `process`, or `node:*` in `src/`. All three surfaces (STT, TTS, realtime S2S) accept an injectable `SocketFactory` — on Workers, outbound provider WebSockets that require auth headers use the fetch-upgrade path via `createWorkersSocket` (not the global `WebSocket` constructor, which cannot set headers).

Wire secrets through the Worker **`env` binding** (Wrangler secrets / vars), not `process.env`. Pass `apiKey` as constructor/initialize config:

```ts
import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { GrokSTTPlugin } from "@kuralle-syrinx/grok/stt";
import { GrokTTSPlugin } from "@kuralle-syrinx/grok/tts";
import { fromGrokRealtime } from "@kuralle-syrinx/grok/realtime";
import { RealtimeBridge } from "@kuralle-syrinx/realtime";
import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";

/** Bound in wrangler.jsonc / dashboard — e.g. XAI_API_KEY secret. */
export interface Env {
  readonly XAI_API_KEY: string;
}

export function createGrokVoiceSession(env: Env): VoiceAgentSession {
  const stt = new GrokSTTPlugin(createWorkersSocket);
  const tts = new GrokTTSPlugin(createWorkersSocket);
  const adapter = fromGrokRealtime({
    apiKey: env.XAI_API_KEY,
    socketFactory: createWorkersSocket,
    voice: "eve",
    turnDetection: { type: "server_vad" },
  });

  const session = new VoiceAgentSession({
    endpointingOwner: "timer",
    plugins: { stt: {}, tts: {}, realtime: {} },
  });
  session.registerPlugin("stt", stt);
  session.registerPlugin("tts", tts);
  session.registerPlugin("realtime", new RealtimeBridge(adapter));
  return session;
}
```

**Durable Object session shape** (see `packages/server-workers`): the Worker `fetch` handler routes `/ws?sessionId=…` to a `VoiceConversation` Durable Object. The DO accepts the client upgrade via `WebSocketPair`, constructs the `VoiceAgentSession` (cascade or bi-model realtime — same env-injection pattern), and pumps audio over the accepted socket. Provider outbound legs (Grok STT/TTS/realtime, Deepgram, Cartesia, …) all dial through `createWorkersSocket` so auth headers ride on the fetch upgrade.

Regression lock: `edge-safety.test.ts` scans `src/` for Node-only primitives and runs the realtime audio path with a mock socket.

## Live smokes

From `examples/02-hello-voice-headless` (requires `XAI_API_KEY`):

```bash
pnpm smoke:grok-stt
pnpm smoke:grok-tts
pnpm smoke:grok-realtime
```
