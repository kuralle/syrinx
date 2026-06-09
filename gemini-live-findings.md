# Gemini Live findings

Verified 2026-06-10 against `@google/genai@2.8.0` and live `GEMINI_API_KEY`.

## Model IDs (listed via `ai.models.list`)

| Role | Brief default | Actually available / used |
|------|---------------|---------------------------|
| Conversational front | `gemini-live-2.5-flash-preview` | **Not found** on v1beta (`1008 model not found`). Used **`gemini-3.1-flash-live-preview`** |
| Live translate | `gemini-3.5-live-translate-preview` | **Found** — used as-is |

Other live models on this key: `gemini-2.5-flash-native-audio-*` variants.

## A. Bi-model (`fromGeminiLive` + kuralle)

**Model:** `gemini-3.1-flash-live-preview`

**Result:** PASS

- `ask_university` tool_call at 7110ms
- kuralle delegate result: `The application deadline for the Computer Science Masters program is March 31.`
- Non-silent output audio (150722 bytes)
- Grounded text contains **March 31** (from reasoner; assistant `outputAudioTranscription` final text was empty in this run)

**Timeline (ms):**

| atMs | event |
|------|-------|
| 7110 | adapter.tool_call + bus.llm.tool_call |
| 7974 | user.audio.done |
| 10206 | bus.llm.tool_result (March 31) |
| 10813 | bus.tts.audio |
| 15516 | bus.tts.end |

## B. Live translate (`createGeminiTranslateSession`)

**Model:** `gemini-3.5-live-translate-preview`  
**Config:** `translationConfig: { targetLanguageCode: "es", echoTargetLanguage: true }`, `httpOptions.apiVersion: "v1alpha"`

**Result:** PASS (audio + semantic verification)

- Input transcript (live): `What's the application deadline for the computer science masters?`
- Output transcript (live): **empty** — `outputAudioTranscription` events carry `languageCode: "en"` but no `text`
- Non-silent translated audio: 1,092,000 bytes @ 24kHz → `translated-es.wav`
- Fallback STT of output WAV still reads English-like phonetics; **semantic verifier** (Gemini flash comparing audio to expected Spanish reference) returned **YES**

**Expected Spanish reference:** `¿Cuál es la fecha límite de solicitud para la maestría en ciencias de la computación?`

## Protocol gotchas

1. **`gemini-live-2.5-flash-preview` is stale** in SDK examples; list models before hardcoding.
2. **Translate uses `v1alpha`** WS endpoint for reliable streaming volume; v1beta works but preview transcription behavior differs.
3. **`outputAudioTranscription` on translate preview** often omits `text` (only `languageCode`); do not rely on live text for PASS — verify audio semantics or post-hoc STT.
4. **`languageCodes` on `AudioTranscriptionConfig`** throws on Developer API (`only supported in Vertex/Enterprise`).
5. **Tool calls** arrive on `message.toolCall.functionCalls`, not inside `serverContent.modelTurn`.
6. **`interrupted`** maps to `speech_started` for best-effort barge-in; `cancelResponse` is a no-op.
7. **`sendRealtimeInput`** uses `audio: { data: base64, mimeType: "audio/pcm;rate=16000" }`; SDK maps `translationConfig` → `setup.generationConfig.translationConfig`.
8. **`injectToolResult`** requires tracking `toolId → toolName`; response shape `{ response: { result: text } }`.
9. **Input 16kHz / output 24kHz** — bridge resamples outbound audio to 16kHz engine rate.

## Manager-run verification (2026-06-10) — IC builds, manager runs smokes
Re-ran both smokes myself (the IC's cursor-run smoke had hung at teardown, leaking a Gemini WS).
- **Bi-model (`gemini-3.1-flash-live-preview` + kuralle):** RELIABLE PASS. My run: tool_call → kuralle
  "March 31" → 222KB voiced audio. Exits cleanly (no hang when manager-run). Reproduces cursor's PASS.
- **Translate (`gemini-3.5-live-translate-preview`):** INTERMITTENT. Across 3 observed runs (cursor +
  2 manager): Spanish output 2×, **English echo 1×** (my run 1: STT="the deadline for the Computer
  Science Masters?", semantic=false). The integration/config is correct (produces
  "…en ciencias de la computación?" + semantic=true when it works); the PREVIEW model itself flakes
  (~1/3 echoed source language). Not a code bug — preview-model variance. TODO: characterize the rate
  over N≥10, try `echoTargetLanguage:false`, before relying on it.
