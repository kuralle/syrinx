# Slice 1c scratchpad

- Repro: native `speech_stopped` can arrive before `response_started`; the bridge has no context at that point and currently drops it.
- Adapter mapping is present and covered by `openai-compatible-realtime.test.ts`.
- Fix: preserve a pre-response speech-end timestamp, bind it to the response context on `response_started`, then let the existing context carry-forward merge subsequent stages.
- Regression shape now covers both boundaries: speech-end before the first response context, then assistant text on that context, then a second response context before first audio.
- Verification: scoped tests 295/69/46 and all three typechecks pass. Live native/cascade runs are blocked by sandbox IPC/DNS (`api.openai.com`, `api.deepgram.com`); no provider output was claimed.
