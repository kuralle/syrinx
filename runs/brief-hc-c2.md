# Brief — Half-cascade C2: @kuralle-syrinx/zeta-tts plugin (HTTP streaming Sinhala TTS)

You are an implementation worker on branch `feat/half-cascade` (already checked out). Spec:
`docs/rfc-half-cascade.md` chunk **C2** (§4.5, §6, §8). Ship finished, verified work.

## Standards (hard)
- No workarounds, no `@ts-ignore`/`as any` to silence types, root-cause only.
- Do NOT claim done without the verification commands passing — capture exit codes.
- New self-contained package only; do not modify other packages.
- Command efficiency: run heavy commands ONCE, capture to a `mktemp` file, inspect that.

## Task
Create a new package `packages/zeta-tts` exporting `ZetaTTSPlugin` (a `VoicePlugin`) that synthesizes
Sinhala (and any) text via the Zeta **HTTP** OpenAI-compatible endpoint and streams PCM into the bus.

## CONTRACT reference (READ FIRST, but note the transport differs)
`packages/deepgram/src/tts.ts` is the `VoicePlugin` contract reference — how a TTS plugin subscribes to
`tts.text`, emits `tts.audio` / `tts.end` / `tts.error`, carries an odd trailing PCM byte across chunks to
stay 16-bit aligned, and handles `interrupt.tts`. **Mirror that structure**, BUT Deepgram is WebSocket —
**Zeta is HTTP `fetch` streaming**, so replace the WS transport with a streamed `fetch` POST.

## Zeta wire contract (from research/half-cascade-spike-results.md)
- `POST {base}/v1/audio/speech`, JSON body:
  `{ model: "zeta", input: <sentence>, response_format: "pcm", stream: true, task_type: "Base", num_steps: <n> }`
- Response body: raw **48 kHz mono s16le PCM**, streamed (`response.body.getReader()`).
- `base` from config `endpoint_url` or env `ZETA_BASE_URL`, default
  `https://asyncdotengineering--zeta-tts-api-zetattsapi.us-east.modal.direct`.
- Optional bearer key: config `api_key` / env `ZETA_API_KEY` → `Authorization: Bearer <key>` when present.
- `num_steps` config, default **8** (fastest TTFB per spike).

## Behavior
- `initialize(bus, config)`: read config; `bus.on("tts.text", ...)` → `synth(text, contextId)`;
  `bus.on("interrupt.tts", ...)` → abort in-flight requests (`AbortController`).
- `synth`: POST with `stream:true`; read the body reader; for each chunk, **resample 48 kHz → engine rate**
  using `StreamingPcm16Resampler` (imported from `@kuralle-syrinx/core`; `new StreamingPcm16Resampler(48000, engineRate).process(Int16Array)`),
  carry odd bytes across chunks, push `TextToSpeechAudioPacket { kind:"tts.audio", contextId, timestampMs,
  audio: Uint8Array, sampleRateHz: engineRate }` on `Route.Main`. Engine rate from config `sample_rate`
  (default 16000). On stream end push `tts.end`.
- Errors: HTTP **503** (Modal cold/asleep) → push a **recoverable** `TtsErrorPacket` + a one-line
  `console.error("[zeta-tts] cold start …")`; other non-2xx / network errors → `tts.error` (categorize via
  `categorizeTtsError`/`isRecoverable` from core, as Deepgram does).
- `close()`: abort in-flight, remove bus listeners.

## Package scaffolding
Mirror `packages/cartesia/package.json` + `packages/cartesia/tsconfig.json`: name `@kuralle-syrinx/zeta-tts`,
version `4.1.0`, `"type":"module"`, `main`/`types` → `./src/index.ts`, scripts `typecheck`/`test`, depend on
`@kuralle-syrinx/core` (workspace:*). Add it to the workspace (it's covered by `packages/*`).

## Red gate FIRST (prove it fails, then implement)
`packages/zeta-tts/src/index.test.ts` with `vi.stubGlobal("fetch", …)` returning a mock `Response` whose
`body` is a `ReadableStream` of PCM bytes:
1. `tts.text` → POST body has `{model:"zeta", response_format:"pcm", stream:true, num_steps:8}` and the input text.
2. streamed PCM → one or more `tts.audio` packets at the engine `sampleRateHz`, then `tts.end`.
3. a 503 response → a `tts.error` packet with `isRecoverable: true`.

## Verify (must pass; write exit codes to `runs/proof-hc-c2.txt`)
```
pnpm install    # register the new workspace package if needed
pnpm --filter @kuralle-syrinx/zeta-tts typecheck
pnpm --filter @kuralle-syrinx/zeta-tts test
```
Do not commit or push. Report the exit codes and the test names.
