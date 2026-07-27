# @kuralle-syrinx/deepgram

Deepgram STT and TTS for [Syrinx](https://github.com/kuralle/syrinx).

> Deepgram adapters for Syrinx — nova-3 STT, Flux turn-aware STT (semantic end-of-turn), and Aura TTS

```bash
npm install @kuralle-syrinx/deepgram
```

Three adapters:

| Export | What it is |
| --- | --- |
| `DeepgramSTTPlugin` | nova-3 streaming transcription |
| `DeepgramFluxSTTPlugin` | Flux turn-aware STT — **semantic** end-of-turn, not silence timers |
| `DeepgramTTSPlugin` | Aura streaming synthesis |

```ts
import { DeepgramSTTPlugin } from '@kuralle-syrinx/deepgram';
session.registerPlugin('stt', new DeepgramSTTPlugin());
// plugins config: { api_key: process.env.DEEPGRAM_API_KEY, model: 'nova-3', sample_rate: 16000 }
```

The Flux variant decides a turn ended from what was *said*, not from how long the line
went quiet — which is the difference between cutting off someone who paused to think and
waiting through silence you already knew was final.

Subpaths `./stt` and `./tts` import one side without the other.

## License

MIT
