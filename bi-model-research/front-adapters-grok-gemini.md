# Front adapters — Grok Voice & Gemini Live native audio

> Exploration of the next two `RealtimeAdapter` front models after `gpt-realtime-2`, mapped to the
> `@kuralle-syrinx/realtime` `caps` model. Sources (fetched 2026-06-06): xAI Voice Agent docs
> (`docs.x.ai/.../audio/voice-agent`), Gemini Live capabilities (`ai.google.dev/gemini-api/docs/live-api`).
> Companion to [`blueprint.md`](./blueprint.md) §3.1 (the adapter interface) and
> [`../docs/rfc-realtime-bridge.md`](../docs/rfc-realtime-bridge.md).

## TL;DR

- **Grok** = ~drop-in. `fromGrokRealtime` reuses most of `fromOpenAIRealtime` (it speaks the OpenAI
  Realtime event schema) — change URL/model/key, set `caps` (no truncate, blocking tools, **no
  `speech_started`**), drop the truncate call. The one real gap: **Grok emits no
  `input_audio_buffer.speech_started`**, so provider-driven barge-in detection doesn't exist — needs a
  fallback.
- **Gemini** = new protocol. `fromGeminiLive` is a fresh mapping (`BidiGenerateContent`, not OpenAI
  events) but fits the same `RealtimeAdapter` interface. Input is **16 kHz** (= engine rate → no input
  resample), tools are blocking on 3.1 (NON_BLOCKING on 2.5), barge-in arrives as a server `interrupted`
  flag (the model already canceled) rather than a `speech_started` we react to.

## The divergence matrix (why `caps` exists)

| axis | gpt-realtime-2 | grok-voice-think-fast-1.0 | gemini-3.1-flash-live-preview |
|---|---|---|---|
| wire protocol | OpenAI Realtime | **OpenAI Realtime subset** | `BidiGenerateContent` (distinct) |
| endpoint | `wss://api.openai.com/v1/realtime` | `wss://api.x.ai/v1/realtime?model=` | Google GenAI Live WS |
| auth | `Authorization: Bearer` | `Authorization: Bearer` (same) | server key / ephemeral token |
| input rate | 24 kHz | configurable (8/16/24/…); **set 16k** | **16 kHz** |
| output rate | 24 kHz | 24 kHz default (configurable) | 24 kHz |
| async fn-calling (`supportsConcurrentToolAudio`) | ✅ native | ❌ blocking | ❌ 3.1 / ✅ 2.5 (`behavior:NON_BLOCKING`) |
| `conversation.item.truncate` (`supportsTruncate`) | ✅ | ❌ | ❌ (server-driven) |
| server `speech_started` (**new cap** `emitsServerSpeechStarted`) | ✅ | ❌ | ✅ (as `interrupted:true`) |
| telephony codecs in-band | — | ✅ `pcmu`/`pcma` 8 kHz | — |

**Action:** add one cap — `emitsServerSpeechStarted: boolean` — to `RealtimeAdapter.caps`, and gate the
bridge's barge-in *detection* path on it (today the bridge assumes `speech_started` always comes).

## Grok Voice Agent — `fromGrokRealtime`

- **Models:** `grok-voice-think-fast-1.0` (flagship), `grok-voice-latest`. TTFA <1 s.
- **Reuse:** shares `session.update`, `input_audio_buffer.append`, `response.create`,
  `conversation.item.create`(`function_call_output`), `response.output_audio.delta`, `response.done`.
  → the existing OpenAI event-mapping core is reusable. Cleanest path: **extract the OpenAI mapping into a
  shared helper** and have `fromGrokRealtime` set URL/model/key + `caps` + the deltas below.
- **Deltas to handle:**
  - `caps`: `{supportsConcurrentToolAudio:false, supportsTruncate:false, emitsServerSpeechStarted:false}`.
  - `cancelResponse`: send `response.cancel` only (no `conversation.item.truncate` — unsupported). The
    `activeResponse` guard we already added still applies.
  - Blocking tools: after `function_call_output`, **wait until current audio playback completes** before
    `response.create` (xAI doc) — i.e. don't lead-in-while-pending; bridge inserts a stall filler (the
    `supportsConcurrentToolAudio:false` path) or accepts an audible gap.
  - Input transcription event is `conversation.item.input_audio_transcription.updated` (cumulative), not
    `.delta` — only matters if/when we consume user-input transcripts (we currently don't).
  - Set `audio.input/output` pcm rate to **16000** to skip both resamples (engine-native). Bonus:
    `pcmu`/`pcma` 8 kHz support is a direct telephony fit.
- **Open question (real):** with no `speech_started`, how is barge-in detected? Options: (a) Grok exposes a
  different turn/interruption event — verify via a live socket dump; (b) fall back to **kernel/client VAD**
  for the Grok path (register a VAD plugin or use client `audio_clear`), which contradicts the
  "model owns turn-taking" simplification. Resolve before building barge-in for Grok.

## Gemini Live native audio — `fromGeminiLive`

- **Models:** `gemini-3.1-flash-live-preview` (primary), `gemini-2.5-flash-native-audio-preview-12-2025`
  (the 2.5 one is the only path to async/NON_BLOCKING tools).
- **New protocol mapping (→ `RealtimeEvent`):**
  - setup: `BidiGenerateContentSetup{ model, config:{ response_modalities:["AUDIO"], speech_config.voice_config.prebuilt_voice_config.voice_name, thinking_config.thinking_level, system_instruction, tools } }`.
  - `sendAudio` → `BidiGenerateContentRealtimeInput{ audio:{ data, mime_type:"audio/pcm;rate=16000" } }` — **input already 16 kHz, no resample**.
  - audio out → `serverContent.model_turn.parts[].inline_data{ data, mime_type:"audio/pcm;rate=24000" }` → `{type:"audio", sampleRateHz:24000}` (resample 24k→16k).
  - tool call → `serverContent.model_turn.parts[].functionCall{name,args}` → `{type:"tool_call"}`; result back via `toolResponse{id,output}`.
  - **barge-in:** `serverContent.interrupted:true` → emit our `speech_started`/interrupt signal so Syrinx
    clears local playout (the model already canceled server-side); pending function calls arrive canceled
    with IDs. `cancelResponse` is effectively a no-op / `activity_end` rather than a truncate.
  - optional `proactivity.proactive_audio:true` — maps to the TML-style "speak when warranted" behavior.
- **`caps`:** `{inputSampleRateHz:16000, outputSampleRateHz:24000, supportsTruncate:false,
  emitsServerSpeechStarted:true(via interrupted), supportsConcurrentToolAudio: model==='2.5'?true:false}`.
- **Note:** Gemini owns VAD/interruption end-to-end (custom VAD via `activity_start`/`activity_end`), so
  the bridge's barge-in becomes "react to the provider's `interrupted`" rather than "detect and tell the
  provider to cancel" — a cleaner fit than Grok, opposite ownership from OpenAI.

## Recommended build order (next delegation handoffs)

1. **Refactor:** extract the OpenAI Realtime event mapping into a shared module; add
   `emitsServerSpeechStarted` to `caps`; gate the bridge barge-in *detection* on it. (small, unblocks both)
2. **`fromGrokRealtime`** (cheap — reuses the mapping): URL/model/key + caps + no-truncate + blocking-tool
   stall. Live gate: Grok university bi-model turn. Resolve the no-`speech_started` barge-in question.
3. **`fromGeminiLive`** (new protocol): full `BidiGenerateContent` mapping; 16 k input (no resample);
   `interrupted`-driven barge-in; pick 2.5-native-audio if we want async tools. Live gate: Gemini
   university bi-model turn + a barge-in check (server `interrupted`).

All three remain the SAME `RealtimeBridge` + `Reasoner` seam — only the adapter + caps differ, which is
exactly the design's bet.
