# @kuralle-syrinx/openai-tts

OpenAI-compatible streaming TTS plugin for Syrinx.

Supports any provider that implements the OpenAI `POST /audio/speech` endpoint with `stream: true` and returns raw mono s16le PCM. Configurable `base_url`, `api_key`, `model`, `voice`, `response_format`, `source_sample_rate_hz`, `sample_rate`, `tempo`, and `extra_body`.

Includes a built-in WSOLA time-stretcher for pitch-preserving tempo control (e.g. `tempo: 0.9` to slow speech by 10%).

## Usage

### OpenAI (default)

```ts
import { OpenAICompatibleTTSPlugin } from "@kuralle-syrinx/openai-tts";

const plugin = new OpenAICompatibleTTSPlugin();
session.registerPlugin("tts", plugin);
```

Configuration:

```ts
{
  api_key: "sk-...",                // or set OPENAI_API_KEY env
  model: "gpt-4o-mini-tts",         // default
  voice: "alloy",
  response_format: "pcm",           // default
  sample_rate: 16000,               // engine rate; default 16000
  tempo: 1.0,                       // WSOLA stretch; default 1.0
}
```

### Zeta (internal Sinhala TTS)

Zeta is used purely via config — no special factory or import.

```ts
import { OpenAICompatibleTTSPlugin } from "@kuralle-syrinx/openai-tts";

const plugin = new OpenAICompatibleTTSPlugin();
session.registerPlugin("zeta", plugin);
```

Configuration:

```ts
{
  base_url: "https://asyncdotengineering--zeta-tts-api-zetattsapi.us-east.modal.direct/v1",
  api_key: "",                      // Zeta is unauthenticated
  model: "zeta",
  source_sample_rate_hz: 48000,     // Zeta outputs 48 kHz PCM
  sample_rate: 24000,               // engine rate
  tempo: 0.9,                       // 10% slower — Zeta prosody rushes
  extra_body: {
    task_type: "Base",
    num_steps: 8,
  },
}
```

## Config reference

| Key | Type | Default | Description |
|---|---|---|---|
| `base_url` | `string` | `https://api.openai.com/v1` | Provider base URL (must include `/v1`). Falls back to `OPENAI_BASE_URL` env. |
| `api_key` | `string` | — | Bearer token. Falls back to `OPENAI_API_KEY` env. |
| `model` | `string` | `gpt-4o-mini-tts` | TTS model name. |
| `voice` | `string` | — | Voice identifier. Included in the request body only when set. |
| `response_format` | `string` | `pcm` | Audio format. |
| `source_sample_rate_hz` | `number` | `24000` | Provider's output PCM sample rate. |
| `sample_rate` | `number` | `16000` | Engine sample rate to resample to. |
| `tempo` | `number` | `1.0` | WSOLA time-stretch factor (`0.5`–`1.5`). |
| `extra_body` | `object` | — | Merged into the request JSON body last (overrides defaults). |
