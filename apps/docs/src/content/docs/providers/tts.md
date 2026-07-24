---
title: TTS providers
description: Config reference for every streaming text-to-speech provider Syrinx ships.
---

Every TTS plugin here is a wire protocol over the shared `@kuralle-syrinx/tts-core` lifecycle — multi-context streaming and usage billing work identically regardless of which one you pick.

## Cartesia

```ts
import { CartesiaTTSPlugin } from '@kuralle-syrinx/cartesia';

const tts = new CartesiaTTSPlugin(socketFactory);
await tts.initialize(bus, {
  api_key: process.env.CARTESIA_API_KEY!,
  voice_id: process.env.CARTESIA_VOICE_ID,
  model_id: 'sonic-3',
  language: 'en',
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `voice_id` | a premade Cartesia voice | Override with your own voice. |
| `model_id` | `sonic-3` | |
| `language` | `en` | |
| `output_container` / `output_encoding` | `raw` / `pcm_s16le` | |
| `cartesia_version` | `2024-06-10` | API version header. |

## ElevenLabs

Multi-context WebSocket streaming — several concurrent TTS contexts on one connection, which is what makes fast barge-in cheap.

```ts
import { ElevenLabsTTSPlugin } from '@kuralle-syrinx/elevenlabs';

const tts = new ElevenLabsTTSPlugin(socketFactory);
await tts.initialize(bus, {
  api_key: process.env.ELEVENLABS_API_KEY!,
  voice_id: process.env.ELEVENLABS_VOICE_ID,
  model_id: 'eleven_flash_v2_5',
  sample_rate: 16000,
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `voice_id` | a free-tier-accessible premade voice | Library voices (e.g. Rachel) require a paid plan. |
| `model_id` | `eleven_flash_v2_5` | |
| `sample_rate` | `16000` | |

Usage is billed on audio received, not on the provider's `isFinal` flag — a rejected generation never bills.

## Deepgram Aura

```ts
import { DeepgramTTSPlugin } from '@kuralle-syrinx/deepgram';

const tts = new DeepgramTTSPlugin(socketFactory);
await tts.initialize(bus, {
  api_key: process.env.DEEPGRAM_API_KEY!,
  model: 'aura-2-thalia-en',
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `model` | `aura-2-thalia-en` | Picks both voice and language. |

## Gemini

Non-streaming (chunked): the full text is sent and the complete audio comes back in one response.

```ts
import { GeminiTTSPlugin } from '@kuralle-syrinx/gemini';

const tts = new GeminiTTSPlugin();
await tts.initialize(bus, {
  api_key: process.env.GEMINI_API_KEY!,
  model: 'gemini-3.1-flash-tts-preview',
  voice_name: 'Kore',
  sample_rate: 24000,
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `model` | `gemini-3.1-flash-tts-preview` | Also: `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`. |
| `voice_name` | `Kore` | One of `Kore`, `Puck`, `Charon`, `Fenrir`, `Leda`, `Aoede`, `Zephyr`, `Orus`. |
| `instruction` | empty | A style/persona lead-in prepended to every utterance. Empty by default — set it explicitly if you want one. |
| `language_code` | — | |
| `sample_rate` | `24000` | |

## Grok (xAI)

```ts
import { GrokTTSPlugin } from '@kuralle-syrinx/grok/tts';

const tts = new GrokTTSPlugin(socketFactory);
await tts.initialize(bus, {
  api_key: process.env.XAI_API_KEY!,
  voice_id: 'eve',
  sample_rate: 16000,
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `voice_id` | `eve` | |
| `sample_rate` | `16000` | |

## Any OpenAI-compatible endpoint

`OpenAICompatibleTTSPlugin` speaks the OpenAI `POST /v1/audio/speech` streaming contract, so it works against OpenAI's own TTS or any self-hosted / third-party endpoint that implements the same API.

```ts
import { OpenAICompatibleTTSPlugin } from '@kuralle-syrinx/openai-tts';

const tts = new OpenAICompatibleTTSPlugin();
await tts.initialize(bus, {
  api_key: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
});
```

| Key | Default | Notes |
|---|---|---|
| `base_url` | `https://api.openai.com/v1` | Point this at a self-hosted endpoint to use a different backend. |
| `api_key` | — | |
| `model` | `gpt-4o-mini-tts` | |
| `voice` | — | |
| `response_format` | `pcm` | |
| `source_sample_rate_hz` | `24000` | The provider's output sample rate. |
| `sample_rate` | `16000` | Engine rate to resample to. |
| `tempo` | `1.0` | Pitch-preserving time-stretch (`0.5`–`1.5`) via a built-in WSOLA stretcher — use `0.9` to slow speech 10% without changing pitch. |
| `extra_body` | — | Merged into the request body last; use it for any provider-specific field the plugin doesn't enumerate. |

## Choosing between them

- **Want the widest voice library and fastest barge-in?** ElevenLabs' multi-context streaming.
- **Want a large multilingual catalog with per-language model selection?** Cartesia.
- **Already on Deepgram for STT?** Aura keeps you on one vendor and one bill.
- **Have a self-hosted or fine-tuned TTS model?** `OpenAICompatibleTTSPlugin` against your own `base_url` — no custom plugin required as long as it speaks the OpenAI speech API shape.

See [Usage & pricing](/reference/usage-and-pricing/) for cited per-character rates.
