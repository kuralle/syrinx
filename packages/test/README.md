# @kuralle-syrinx/test

Scripted fakes for testing for [Syrinx](https://github.com/kuralle/syrinx).

> Scripted fake STT/TTS/LLM plugins for testing Syrinx voice pipelines

```bash
npm install @kuralle-syrinx/test
```

Deterministic fake plugins so a voice pipeline can be tested without calling a
provider — no keys, no network, no per-run cost, and the same answer every time.

```ts
import { FakeSTT, FakeTTS, FakeBridge, FakeVAD } from '@kuralle-syrinx/test';

// The fakes take NO constructor arguments — their scripts come through the session's
// `plugins` config, exactly like a real plugin's api_key does.
const session = new VoiceAgentSession({
  plugins: {
    stt: { scriptedEvents: [{ kind: 'final', text: 'what is the deadline?', confidence: 0.99, ts: Date.now() }] },
    bridge: { scriptedEvents: [{ kind: 'text', delta: 'March first.' }, { kind: 'done' }] },
    tts: { scriptedAudioBatches: [{ frame: pcmFrame, final: true }] },
  },
  sttForceFinalizeTimeoutMs: 0,
});

session.registerPlugin('stt', new FakeSTT());
session.registerPlugin('bridge', new FakeBridge());
session.registerPlugin('tts', new FakeTTS());
```

`FakeVAD` additionally exposes `processFrame(contextId)` so a test drives speech
detection deliberately instead of waiting on real audio energy.

Use these to assert turn-taking, interruption and error handling — the behaviours that
are hard to trigger reliably against a live provider and expensive to retry.

## License

MIT
