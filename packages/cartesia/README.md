# @kuralle-syrinx/cartesia

Cartesia streaming TTS for [Syrinx](https://github.com/kuralle/syrinx).

> Cartesia streaming TTS adapter for Syrinx

```bash
npm install @kuralle-syrinx/cartesia
```

`CartesiaTTSPlugin` speaks the assistant's replies over Cartesia's streaming
WebSocket API — text frames in, PCM out, while the reply is still being generated.

```ts
import { CartesiaTTSPlugin } from '@kuralle-syrinx/cartesia';

session.registerPlugin('tts', new CartesiaTTSPlugin());
// plugins config: { api_key: process.env.CARTESIA_API_KEY, voice_id: '…' }
```

`CARTESIA_VOICE_ID` is required alongside the key — a missing voice id fails at
synthesis, not at startup.

Built on [`@kuralle-syrinx/tts-core`](https://www.npmjs.com/package/@kuralle-syrinx/tts-core),
which owns the streaming lifecycle (carry, refcounting, finish timeout, cancel) so
adapters stay thin.

## License

MIT
