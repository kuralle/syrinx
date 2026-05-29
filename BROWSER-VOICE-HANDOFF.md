# Browser Voice Review Handoff

## Purpose

Use this to test the browser websocket voice path end to end: microphone capture, browser resampling, websocket audio frames, assistant websocket audio decode/playback scheduling, server VAD/STT finalization, streamed agent text, TTS audio playback, and interruption handling.

The browser is not push-to-talk by default. After `Start Listening`, the microphone stays open. A browser-side energy gate creates a new capture context with 400 ms of pre-speech audio; server VAD, Smart Turn, and provider STT finalization own end-of-turn.

## Automated Smoke

Run the headless Chrome browser runtime smoke:

```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:browser-runtime
```

Expected result:

- `qualityGate.passed` is `true`.
- The run writes `examples/02-hello-voice-headless/test/performance/runs/browser-runtime-<timestamp>/baseline.json`.
- Browser reports `audioContextSampleRateHz` greater than `0`.
- Browser reports `targetSampleRateHz: 16000`.
- Browser sends at least two frames and every sent frame is counted as an envelope frame. Continuous listening may allocate a second context after assistant audio is cleared.
- Server receives the browser capture context ids and even-byte PCM.
- Browser receives at least one assistant audio frame, decodes it as a `syrinx.audio.v1` envelope, records non-empty assistant PCM bytes, and observes at least one audio clear event.

Latest verified run:

- `browser_runtime_capture_to_websocket`
- `audioContextSampleRateHz: 48000`
- `targetSampleRateHz: 16000`
- Artifact: `examples/02-hello-voice-headless/test/performance/runs/browser-runtime-2026-05-29T12-53-36-642Z/baseline.json`
- `sentFrames: 87`
- `sentEnvelopeFrames: 87`
- `sentBytes: 55298`
- `receivedAssistantAudioFrames: 1`
- `receivedAssistantEnvelopeFrames: 1`
- `receivedAssistantBytes: 16000`
- `assistantSampleRateHz: 16000`
- `audioClearEvents: 1`
- `startedTurns: 2` under the fake microphone because continuous listening immediately opens the next capture context after assistant audio is cleared.

## Manual Browser Review

The browser review page is `packages/voice-client-browser/index.html`, but do not open it directly with `file://`. Start the review server so the page is served from localhost and the websocket endpoint is running in the same process.

Prerequisites:

- `.env` at the repo root must contain `DEEPGRAM_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY`.
- For the default interactive path, `.env` should also contain `CARTESIA_API_KEY`. Without Cartesia, the server falls back to Gemini TTS.
- Use Chrome or Edge for the most reliable local microphone behavior.

Start the server:

```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
pnpm --filter @asyncdot-example/02-hello-voice-headless review:studio
```

The server prints both URLs. By default they are:

```text
http://127.0.0.1:4173
ws://127.0.0.1:4173/ws
```

Open `http://127.0.0.1:4173` in the browser and allow microphone permission when prompted. If port `4173` is busy, start with another port:

```bash
SYRINX_REVIEW_PORT=4174 pnpm --filter @asyncdot-example/02-hello-voice-headless review:studio
```

Then open `http://127.0.0.1:4174`.

Manual test flow:

1. Click `Connect`.
2. Click `Start Listening`.
3. Speak a natural utterance and stop speaking without clicking the button.
4. Confirm the timeline moves through listening, finalizing, agent, TTS, and done.
5. Confirm assistant audio plays.
6. While assistant audio is playing, speak again and confirm assistant playback clears and the new user turn starts.
7. Click `Stop Listening` when finished.

Expected success signals:

- The browser stays in continuous listening mode after `Start Listening`.
- A user turn appears without using push-to-talk.
- The timeline shows `speech_started`, `speech_ended`, provider final transcript, agent text, TTS audio, and done.
- Assistant audio plays through the browser; the default enveloped binary audio is decoded before playback.
- Speaking during assistant audio emits interruption/clear behavior and starts a new turn.

Useful debugging:

- Health check: `curl http://127.0.0.1:4173/healthz`.
- To point the page at a different websocket server, open `http://127.0.0.1:4173?ws=ws://HOST:PORT/ws`.
- In DevTools, inspect `window.__syrinxReviewState` for sent frame count, sent byte count, context ids, started turn count, browser `AudioContext` sample rate, and target sample rate.

## Build And Unit Checks

Run browser package checks:

```bash
pnpm --filter @asyncdot/voice-client-browser test
pnpm --filter @asyncdot/voice-client-browser typecheck
pnpm --filter @asyncdot/voice-client-browser build
```

Run the websocket protocol checks that protect the browser transport:

```bash
pnpm --filter @asyncdot/voice-server-websocket test
pnpm --filter @asyncdot-example/02-hello-voice-headless typecheck
```

## Debug Notes

- The review console accepts `?ws=ws://host:port/ws` to point at a specific websocket server.
- The review page exposes `window.__syrinxReviewState` for smoke tests: sent frame count, sent byte count, context ids, started turn count, browser `AudioContext` sample rate, and target sample rate.
- Browser outbound audio is mono PCM16 in `syrinx.audio.v1` binary envelopes with `sampleRateHz`; server normalizes to engine sample rate. JSON audio frames remain supported for scripted smokes only when they include explicit `sampleRateHz`.
- Binary assistant audio uses the default `syrinx.audio.v1` envelope for in-frame turn/sample-rate/byte metadata. The preceding `tts_chunk` remains useful for UI lifecycle timing.
- Do not add local STT transcript reconstruction in the browser. Provider final text must remain provider-owned.
