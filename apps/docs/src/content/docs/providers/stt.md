---
title: STT providers
description: Config reference for every streaming speech-to-text provider Syrinx ships.
---

Every STT plugin here is a wire protocol over the shared `@kuralle-syrinx/stt-core` lifecycle — reconnect, the interim/final funnel, and usage billing all work identically regardless of which one you pick.

## Deepgram Nova

The flagship cascade STT. Silence-based endpointing with a Finalize handshake state machine for accurate turn boundaries.

```ts
import { DeepgramSTTPlugin } from '@kuralle-syrinx/deepgram';

const stt = new DeepgramSTTPlugin(socketFactory);
await stt.initialize(bus, {
  api_key: process.env.DEEPGRAM_API_KEY!,
  model: 'nova-3',
  language: 'en-US',
  sample_rate: 16000,
  endpointing: 300,
  keyterm: ['Syrinx', 'onboarding'],
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `model` | `nova-3` | |
| `language` | `en-US` | |
| `sample_rate` | `16000` | |
| `endpointing` | `300` | Silence, in ms, before a turn is considered finished. |
| `keyterm` | — | Repeatable; biases recognition toward domain terms. |
| `encoding` | `linear16` | |

Supports mid-call [reconfigure](/reference/stt-reconfigure/) (keyterms, endpointing, language) via a reconnect at the turn boundary.

## Deepgram Flux

A turn-aware model — one API call handles transcription **and** semantic end-of-turn, so you don't need a local endpointer. Runs over a plain WebSocket, which makes it the only semantic-EOT option available on the Cloudflare Workers edge.

```ts
import { DeepgramFluxSTTPlugin } from '@kuralle-syrinx/deepgram';

const stt = new DeepgramFluxSTTPlugin(socketFactory);
await stt.initialize(bus, {
  api_key: process.env.DEEPGRAM_API_KEY!,
  eot_threshold: 0.7,
  eager_eot_threshold: 0.5,
  eot_timeout_ms: 5000,
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `model` | `flux-general-en` | |
| `eot_threshold` | `0.7` | Confidence required to fire `EndOfTurn`. |
| `eager_eot_threshold` | unset | Set to enable eager mode — an early, retractable end-of-turn signal for [speculative generation](/concepts/overview/#built-for-the-voice-to-voice-budget). |
| `eot_timeout_ms` | `5000` | |
| `keyterm` | — | |
| `language_hint` | — | Soft language bias — see [`languageHints` vs `language`](/reference/stt-reconfigure/). |

Supports mid-call reconfigure (keyterms, EOT thresholds, language hints) **in-band**, without a reconnect.

## ElevenLabs — Scribe v2 Realtime

```ts
import { ElevenLabsSTTPlugin } from '@kuralle-syrinx/elevenlabs';

const stt = new ElevenLabsSTTPlugin(socketFactory);
await stt.initialize(bus, {
  api_key: process.env.ELEVENLABS_API_KEY!,
  sample_rate: 16000,
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `sample_rate` | `16000` | |

Owns its own endpointing (`provider_stt`) — you don't need a separate VAD or endpointer alongside it.

## Google Cloud Speech-to-Text v2

```ts
import { GoogleSTTPlugin } from '@kuralle-syrinx/google';

const stt = new GoogleSTTPlugin(socketFactory);
await stt.initialize(bus, {
  api_key: process.env.GOOGLE_API_KEY!,
  project_id: process.env.GOOGLE_PROJECT_ID!,
  language: 'en-US',
  model: 'latest_long',
  confidence_threshold: 0,
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `project_id` | — | Required. |
| `language` / `language_codes` | `en-US` | `language_codes` accepts multiple for auto-detect. |
| `model` | `latest_long` | |
| `location` | `global` | |
| `recognizer` | `_` | |
| `confidence_threshold` | `0` | Results below this confidence are dropped rather than emitted. |
| `encoding` | `LINEAR16` | |

## Grok (xAI)

```ts
import { GrokSTTPlugin } from '@kuralle-syrinx/grok/stt';

const stt = new GrokSTTPlugin(socketFactory);
await stt.initialize(bus, {
  api_key: process.env.XAI_API_KEY!,
  language: 'en',
  sample_rate: 16000,
});
```

| Key | Default | Notes |
|---|---|---|
| `api_key` | — | Required. |
| `language` | `en` | |
| `sample_rate` | `16000` | |

## Choosing between them

- **Turn-taking already solved and want to run on the Workers edge?** Deepgram Flux is the only semantic-EOT provider that doesn't need a local ONNX model.
- **Want the most battle-tested silence-based endpointing?** Deepgram Nova.
- **Already on ElevenLabs for TTS?** ElevenLabs STT shares your account and billing.
- **On GCP already?** Google Cloud Speech-to-Text v2.

See [STT reconfigure](/reference/stt-reconfigure/) for which of these support mid-call biasing, and [Usage & pricing](/reference/usage-and-pricing/) for cited rates.
