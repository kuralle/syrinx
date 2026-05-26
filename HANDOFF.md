# Syrinx Voice Engine - Session Handoff

**Date:** 2026-05-26
**Working dir:** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`
**Current focus:** v2 websocket-first speech engine reliability, Pipecat Smart Turn endpointing, and live cascade developer smokes.

## Current State

The v2 kernel is the active path. Do not preserve v1 compatibility unless explicitly requested.

The production websocket cascade now runs:

```text
16 kHz websocket PCM user audio
  -> Silero VAD
  -> Pipecat Smart Turn v3 local ONNX endpoint classifier
  -> Deepgram STT with provider Finalize control
  -> AI SDK Gemini agent + tools
  -> Cartesia TTS for interactive review or Gemini TTS for fixture longform
  -> websocket PCM / WAV artifacts
```

Key implementation points:

- `@asyncdot/voice-turn-pipecat` now bundles Pipecat `smart-turn-v3.2-cpu.onnx` and runs local Whisper-feature ONNX inference with `onnxruntime-node`.
- Smart Turn emits `stt.finalize` only after it approves a boundary; Deepgram now sends the provider `Finalize` control frame and falls back to cached interim text if the provider does not answer.
- Websocket clients receive VAD `speech_started` / `speech_ended`, `audio_clear`, and `agent_interrupted`; the browser review console flushes queued output audio on interruption.
- The websocket smokes now assert no negative timing, all VAD boundaries are observed, and longform replies are not visibly truncated.

## Live Baselines

### Interactive Review

Command:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-interactive
```

Latest successful baseline:

| Item | Value |
|---|---:|
| Scenario | `websocket_university_student_relations_interactive` |
| Turns | 3 |
| Input/output PCM | 16 kHz mono s16le |
| TTS provider | Cartesia streaming websocket |
| Trailing silence | 1,400 ms |
| Post-TTS drain | 500 ms |
| Avg STT final after speech end | 1,776 ms |
| Avg VAD speech end after audio end | 627 ms |
| Avg LLM first text after STT final | 3,705 ms |
| Avg Cartesia first audio after first agent text | 377 ms |
| Avg speech end to first assistant audio | 5,858 ms |
| Quality gate | Passed |

Artifacts:

- `examples/02-hello-voice-headless/test/performance/websocket-university-interactive-baseline.json`

### Longform Websocket

Command:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-university
```

Latest successful completed run:

| Item | Value |
|---|---:|
| Scenario | `websocket_university_student_relations_multiturn` |
| Turns | 24 |
| Modeled conversation | 702,408 ms (~11.7 min) |
| User fixture audio | 333,024 ms |
| Assistant TTS audio | 369,384 ms |
| Avg STT final after speech end | 2,307 ms |
| Avg VAD speech end after audio end | 1,776 ms |
| Avg LLM first text after STT final | 3,901 ms |
| Avg Gemini TTS first audio after agent end | 9,833 ms |
| Avg speech end to first assistant audio | 16,041 ms |
| Quality gate | Passed after re-evaluation with critical-turn tool gate |

Artifacts:

- `examples/02-hello-voice-headless/test/performance/websocket-university-multiturn-baseline.json`
- `examples/02-hello-voice-headless/test/performance/runs/websocket-university-2026-05-26T17-48-03-882Z/`

Interpretation: endpointing is now bounded by Smart Turn + Deepgram provider finalize instead of the old 15-20 s generic guard. The remaining longform bottleneck is Gemini LLM/free-tier latency and Gemini's non-streaming TTS generation.

## Commands

Generate the user-side Gemini TTS WAV fixtures:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless fixtures:gemini-university
```

Run the full websocket multi-turn smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-university
```

Run the interactive websocket latency smoke:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:websocket-interactive
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

## Known Gaps

Critical next hardening:

- Cartesia or another true streaming TTS path should be the default for interactive production review. Gemini TTS is still chunked and creates 7-20 s longform TTS outliers.
- Gemini LLM TTFT is still multi-second on the current key. A paid/low-latency Gemini setup is still needed to approach the sub-second target.
- Add explicit websocket audio frame metadata or a binary frame envelope if browser playback metrics need turn-perfect attribution without a post-`tts_end` drain window.
- Tighten semantic quality gates beyond punctuation/length: verify required facts per scenario, not only transport continuity and tool coverage.
- Add browser mic resampling tests. The production websocket contract is 16 kHz PCM; Safari/browser capture cannot be trusted to honor a requested `AudioContext` sample rate.

## Notes For Next Session

- Do not delete `test-cartesia-output.pcm` unless explicitly asked; it is an unrelated untracked local artifact.
- The new `stt.finalize` packet is a command from turn detection to STT; Deepgram responds by sending its provider `Finalize` message and then publishing `stt.result`.
- Smart Turn should not be replaced with raw VAD silence finalization. A short VAD-ended timer caused premature transcript cuts on realistic utterances.
- Keep separate profiles:
  - `interactive-review`: 16 kHz websocket PCM, Smart Turn, Deepgram provider finalize, Cartesia TTS.
  - `longform`: Gemini-generated user fixtures, 16 kHz websocket ingress, Smart Turn, Deepgram provider finalize, Gemini TTS artifacts.
