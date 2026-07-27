# @kuralle-syrinx/tts-core

Shared streaming-TTS lifecycle for [Syrinx](https://github.com/kuralle/syrinx).

> Shared streaming-TTS lifecycle engine for Syrinx TTS adapters — carry, refcount, finish-timeout, cancel

```bash
npm install @kuralle-syrinx/tts-core
```

The lifecycle every streaming TTS adapter needs, factored out once: carry
buffers across frame boundaries, refcount contexts, finish timeouts, and cancel on
barge-in.

Adapters (`cartesia`, `elevenlabs`, `deepgram`, `openai-tts`) are thin wire protocols
over this. If you are writing a new TTS adapter, implement the protocol and let this own
the lifecycle — the edge cases here were found the expensive way.

Its `onText` returns as soon as frames are written rather than awaiting synthesis, so a
reconnect cannot stall the pipeline bus behind it.

## License

MIT
