# Syrinx Voice Engine — Session Handoff

**Date:** 2026-05-26
**Working dir:** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`
**Current focus:** v2 websocket-first speech engine reliability, with production-grade STT/LLM/TTS cascade evidence.

---

## Current State

The v2 kernel is the active path. Do not preserve v1 compatibility unless explicitly requested.

Two websocket paths are now available:

- `reliability-longform`: generated WAV fixtures, conservative finalization, long multi-turn smoke.
- `interactive-review`: browser push-to-talk, 16kHz PCM over websocket, normal Deepgram speech-final finalize, Cartesia TTS by default when the key is present.

The main cascade now has a long-form websocket smoke:

```
Gemini user TTS fixtures -> browser-style WebSocket audio frames
  -> Deepgram STT -> AI SDK Gemini agent + tools -> Gemini TTS -> PCM/WAV artifacts
```

The completed baseline is:

| Item | Value |
|---|---:|
| Scenario | `websocket_university_student_relations_multiturn` |
| Turns | 24 |
| Modeled conversation | 643,768ms (~10.7 min) |
| User fixture audio | 333,024ms |
| Assistant TTS audio | 310,744ms |
| Avg STT final after speech end | 20,393ms |
| Avg LLM first text after STT final | 3,412ms |
| Avg Gemini TTS first audio after agent end | 9,115ms |
| Avg speech end to first assistant audio | 32,919ms |
| Tool calls | 17 across 24 turns |

Baseline artifacts:

- `examples/02-hello-voice-headless/test/fixtures/gemini-university-support/`
- `examples/02-hello-voice-headless/test/performance/websocket-university-multiturn-baseline.json`
- `examples/02-hello-voice-headless/test/performance/runs/websocket-university-2026-05-26T14-13-46-417Z/`

Important interpretation: this smoke is a reliability baseline, not an interactive latency baseline. It uses 24kHz Gemini-generated user WAVs, Deepgram endpointing at 5000ms, `finalize_on_speech_final: false`, 5s trailing silence, and a 15s force-finalize timer so internal pauses do not cut user turns. That proves websocket audio completeness across long turns, but it intentionally pushes endpoint latency high.

---

## Recent Package Changes

| Package | Change |
|---|---|
| `@asyncdot/voice-server-websocket` | Emits `turnId` on STT/agent events, emits tool call/result and `tts_end`, and pushes `turn.change` when text/audio `contextId` changes. |
| `@asyncdot/voice-stt-deepgram` | Adds `finalize_on_speech_final` config. Default remains `true`; long-form smoke can disable it and rely on force-finalize. |
| `@asyncdot/voice-bridge-aisdk` | Keeps bounded conversation history, supports `tool_choice`, and wraps streaming with an idle timeout. |
| `@asyncdot/voice-tts-gemini` | Uses documented non-streaming Gemini TTS `generateContent`, adds timeout, retries, and zero-audio failure. |
| `@asyncdot/voice-client-browser` | Review console for push-to-talk websocket testing, turn-scoped JSON audio frames, PCM16 playback, transcript/tool/agent timeline, and client-side latency markers. |
| `@asyncdot-example/02-hello-voice-headless` | Adds Gemini fixture generation and websocket university multi-turn smoke scripts. Uses `ai@^6.0.0`. |

---

## Commands

Generate the user-side Gemini TTS WAV fixtures:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless fixtures:gemini-university
```

Run the full websocket multi-turn smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-university
```

Start the human review studio:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless review:studio
# open http://127.0.0.1:4173
```

Run local verification:

```bash
pnpm -r typecheck
pnpm -r test
git diff --check
```

---

## Known Gaps

Critical next hardening:

- Add a separate low-latency interactive websocket baseline with normal Deepgram speech-final finalize enabled and shorter endpointing.
- Add a response-completeness gate for the smoke. The current gate proves transport continuity and minimum tool coverage, but it does not fail short/truncated agent text.
- Replace conservative fixture endpointing with Pipecat-style STT/VAD turn fusion for production; keep the long-form conservative mode as a regression test for pause safety.
- Add provider-level streaming TTS for the interactive path. Gemini TTS is currently chunked/non-streaming; Cartesia should be preferred for live review when its key is present.
- Add browser/telephony resampling tests. The fixture smoke runs 24kHz PCM; browser mic capture should be normalized to a declared STT sample rate before crossing the websocket.

Provider/business constraints still matter:

- Paid Gemini key is still needed to reduce LLM TTFT from free-tier multi-second behavior toward the ~380ms target.
- Cartesia streaming remains the practical path for low TTS TTFB; Gemini TTS is useful for fixtures and fallback but not sufficient for sub-second voice response.

---

## Notes For Next Session

- Do not delete `test-cartesia-output.pcm` unless the user explicitly asks; it is an unrelated untracked local artifact.
- The long-form websocket baseline was completed live. The final quality gate was adjusted afterward to match the intended "tools on most/critical turns" behavior, then the completed run baseline was re-evaluated.
- The review studio live smoke passed on 2026-05-26 using a 16kHz WAV sent over JSON websocket audio frames: Deepgram produced a final transcript, Gemini/AI SDK produced agent text, Cartesia returned 353,686 bytes of PCM, and `tts_end` arrived with no websocket errors.
- If optimizing latency next, keep two profiles: `reliability-longform` for pause safety and `interactive-review` for live talk latency. Mixing both goals into one endpointing config hides regressions.
