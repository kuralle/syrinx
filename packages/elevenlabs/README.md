# @kuralle-syrinx/elevenlabs

ElevenLabs voice provider for Syrinx — multi-context WebSocket streaming TTS and Scribe v2
Realtime streaming STT.

## Install

```bash
pnpm add @kuralle-syrinx/elevenlabs
```

## Auth

Pass `api_key` (and `voice_id` for TTS) in plugin config. For local smokes, set `ELEVENLABS_API_KEY`
in the repo-root `.env` (the live smoke reads `EL_VOICE_ID` for the TTS voice, defaulting to a
free-accessible premade voice).

## Streaming TTS — `ElevenLabsTTSPlugin`

```typescript
import { ElevenLabsTTSPlugin } from "@kuralle-syrinx/elevenlabs";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

const tts = new ElevenLabsTTSPlugin(createNodeWsSocket);
await tts.initialize(bus, {
  api_key: process.env.ELEVENLABS_API_KEY!,
  voice_id: process.env.ELEVENLABS_VOICE_ID,
  model_id: "eleven_flash_v2_5",
  sample_rate: 16000,
});
```

Connects to `wss://api.elevenlabs.io/v1/text-to-speech/<voice_id>/multi-stream-input`
(`multi-stream-input`, concurrent contexts keyed by `context_id`) via the shared `tts-core`
deep module. Sends the required `InitializeConnectionMulti`-style context-init frame
(`voice_settings` + optional `generation_config`) before a context's first text. `output_format`
and `generation_config` are dev-configurable, not pinned. Default voice
(`EXAVITQu4vr4xnSDxMaL`) is a premade voice accessible to free API accounts — library voices
(e.g. Rachel) require a paid plan; override with `voice_id`.

Usage billing (`usage.recorded{stage:"tts", characters}`) fires on **audio received**, once per
context — not on `isFinal` (ElevenLabs streams audio with `isFinal:null`, and a rejected
generation returns an empty final that must not be billed).

## Streaming STT — `ElevenLabsSTTPlugin`

```typescript
import { ElevenLabsSTTPlugin } from "@kuralle-syrinx/elevenlabs";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

const stt = new ElevenLabsSTTPlugin(createNodeWsSocket);
await stt.initialize(bus, {
  api_key: process.env.ELEVENLABS_API_KEY!,
  sample_rate: 16000,
});
```

Connects to `wss://api.elevenlabs.io/v1/speech-to-text/realtime` (Scribe v2 Realtime, model
`scribe_v2_realtime` by default) via the shared `@kuralle-syrinx/stt-core` session. Provider
`partial_transcript` → `stt.interim`, `committed_transcript` → `stt.result` (`speechFinal: true`).
Usage billing (`usage.recorded{stage:"stt", audioSeconds}`) fires at the final-transcript funnel
with delta-billing. Owns endpointing (`endpointingCapability.owner: "provider_stt"`).

## Pricing

Cited in `@kuralle-syrinx/core`'s `DEFAULT_PRICE_CATALOG`: Scribe v2 STT $0.39/hr;
Flash/Turbo TTS $50/1M characters, Multilingual TTS $100/1M characters.

## Status

Live-verified end-to-end (TTS audio + usage, STT transcript + usage).

## Live smoke

From `examples/02-hello-voice-headless` (requires `ELEVENLABS_API_KEY`; optional `EL_VOICE_ID`):

```bash
pnpm -C examples/02-hello-voice-headless exec tsx scripts/spike-elevenlabs.ts
```

Exercises both TTS (multi-context WS) and STT (Scribe v2 realtime WS) against the live API,
including `usage.recorded` on both stages.
