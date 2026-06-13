# @kuralle-syrinx/epsilon

Epsilon TTS provider for Syrinx — multiplexed WebSocket streaming synthesis (PCM16 mono @ 24 kHz).

## Install

```bash
pnpm add @kuralle-syrinx/epsilon
```

## Configuration

`base_url` and `api_key` are required. Do not hardcode hosting URLs in application code.

```typescript
import { EpsilonTTSPlugin } from "@kuralle-syrinx/epsilon";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";
import { VoiceAgentSession } from "@kuralle-syrinx/core";

const tts = new EpsilonTTSPlugin(createNodeWsSocket);
await tts.initialize(bus, {
  api_key: process.env.EPSILON_API_KEY!,
  base_url: process.env.EPSILON_BASE_URL!,
  voice: "sinhala", // "sinhala" | "english" | "tamil"
  sample_rate: 24000,
});
```

The endpoint and key are read from the environment — never hardcode them:

```bash
EPSILON_BASE_URL=wss://<your-epsilon-host>/v1/audio/speech/ws
EPSILON_API_KEY=<your-key>
```

## Wire protocol

- Connect: `{base_url}/v1/audio/speech/ws?key={api_key}`
- Client: `speak`, `cancel`, `eos`
- Server: binary PCM frames `[u8 idlen][request_id][pcm16le...]` and JSON `started` / `done` / `cancelled` / `error`

## Tests

```bash
pnpm --filter @kuralle-syrinx/epsilon test
SYRINX_LIVE_EPSILON_TEST=1 pnpm --filter @kuralle-syrinx/epsilon test:live
```

The live test may take up to ~40s on cold start; timeout is 120s.
