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

## Edge deployment

All three forms accept an injectable `SocketFactory` — use `createNodeWsSocket` on Node and `createWorkersSocket` on Cloudflare Workers. Source is edge-clean (no `Buffer`, `node:*`, or `process.*` in `src/`).

## Live smokes

From `examples/02-hello-voice-headless` (requires `XAI_API_KEY`):

```bash
pnpm smoke:grok-stt
pnpm smoke:grok-tts
pnpm smoke:grok-realtime
```
