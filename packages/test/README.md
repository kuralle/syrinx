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

session.registerPlugin('stt', new FakeSTT({ script: ['what is the deadline?'] }));
session.registerPlugin('bridge', new FakeBridge({ reply: 'March first.' }));
session.registerPlugin('tts', new FakeTTS());
```

Use these to assert turn-taking, interruption and error handling — the behaviours that
are hard to trigger reliably against a live provider and expensive to retry.

## License

MIT
