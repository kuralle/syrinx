# Grok (xAI) provider — STT + TTS + realtime spec

> Live docs (docs.x.ai, fetched 2026-06-06, "Last updated May 30 2026"). Auth: `Authorization: Bearer
> $XAI_API_KEY` on every WS/HTTP call (server-side; ephemeral tokens for client). All forms carry voice.
> Target package: `@kuralle-syrinx/grok` with subpath exports `./stt`, `./tts`, `./realtime` (mirrors
> `@kuralle-syrinx/deepgram`'s STT+TTS grouping). Voices: `eve` (default), `ara`, `rex`, `sal`, `leo` (+ custom).

## 1. Realtime (Voice Agent) — `fromGrokRealtime` (RealtimeAdapter)
- WS `wss://api.x.ai/v1/realtime?model=grok-voice-latest` (also `grok-voice-think-fast-1.0`). **OpenAI Realtime-compatible subset.**
- `session.update`: `{ voice:"eve", instructions, turn_detection:{type:"server_vad"}, tools:[...] }`.
- Server events shared: `response.output_audio.delta`, `response.done`, `response.function_call_arguments.*`. Input transcript event is `conversation.item.input_audio_transcription.updated` (cumulative).
- **NOT supported** (vs OpenAI): `conversation.item.truncate`, `input_audio_buffer.speech_started`. **Blocking** function calling (model waits for tool output; "wait for audio playback to complete before response.create").
- Audio: `audio/pcm` configurable rate (8/16/22.05/24/32/44.1/48 kHz; default 24k) + pcmu/pcma 8k telephony.
- **caps**: `{ inputSampleRateHz: 24000 (or set 16000), outputSampleRateHz: 24000, supportsConcurrentToolAudio:false, supportsTruncate:false, emitsServerSpeechStarted:false }`.
  - Reuse the `fromOpenAIRealtime` mapping where identical; override: no truncate in `cancelResponse` (response.cancel only), `requiresResponseCreateAfterToolOutput:true` but gated behind blocking-tool semantics, and barge-in detection can't rely on `speech_started` (note the gap — client/kernel VAD fallback, or server-VAD events if Grok exposes them; verify on a live socket).

## 2. STT — `GrokSTTPlugin` (streaming WS; mirror DeepgramSTTPlugin)
- WS `wss://api.x.ai/v1/stt`; **config via URL query params, no setup message**.
- Query: `sample_rate=16000` (native — no resample), `encoding=pcm` (also mulaw/alaw), `interim_results=true`, `language=en`, `endpointing=<ms>` (default 10), `smart_turn=<0..1>` + `smart_turn_timeout=<ms>` (built-in EOS model), `diarize`, `keyterm`, `filler_words`, `multichannel`+`channels`.
- Client: **raw binary PCM frames** (no base64), ~100 ms chunks (3,200 bytes @16k PCM16); then `{"type":"audio.done"}` to flush+close.
- Server events: `transcript.created` (ready — wait before sending), `transcript.partial` `{text,words,is_final,speech_final,start,duration,end_of_turn_confidence}`, `transcript.done`, `error{message}`.
  - **Mapping:** `is_final=false`→`stt.interim`; `is_final=true,speech_final=false`→`stt.result` (chunk final); `is_final=true,speech_final=true`→`stt.result` + (when Grok owns endpointing) the EOS/`eos.turn_complete`. `error`→`stt.error`.
- Native 16 kHz PCM16 → no resampling against the Syrinx engine rate.

## 3. TTS — `GrokTTSPlugin` (streaming WS; mirror DeepgramTTSPlugin / Cartesia)
- WS `wss://api.x.ai/v1/tts?language=en&voice=eve&codec=pcm&sample_rate=16000` (config via query). Codecs: `mp3|wav|pcm|mulaw|alaw`; rate 8/16/22.05/24/44.1/48 kHz. **Use `codec=pcm&sample_rate=16000`** → PCM16 LE, engine-native, feed straight to `tts.audio`. (mulaw@8k available for telephony.)
- Also unary `POST /v1/tts` (json `{text,voice_id,language,output_format:{codec,sample_rate,bit_rate},speed}`) returning audio bytes — for non-streaming.
- Optional `optimize_streaming_latency` (0/1/2) for lower TTFB; `speed` 0.7–1.5; inline speech tags.
- Map provider audio frames → `tts.audio{audio, sampleRateHz}` + `tts.end` per the DeepgramTTSPlugin contract. (Confirm the WS client→server text-send + server→client audio frame shapes against the doc page when implementing — analogous to Cartesia.)

## Notes / decisions
- Realtime barge-in: Grok lacks `speech_started` and `truncate` → the bridge's provider-detected barge-in path doesn't fully apply; document as reduced-capability (rely on client/kernel VAD + response.cancel). Tie to the `emitsServerSpeechStarted`/`supportsTruncate` caps.
- STT/TTS plugins reuse `@kuralle-syrinx/ws` `WebSocketConnection` + injected `SocketFactory` (Node/Workers) exactly like Deepgram — so they're edge-deployable.
- Keep the package edge-clean (no Buffer/node:crypto/process; runtime-agnostic base64 via atob/btoa as in `@kuralle-syrinx/realtime`).
