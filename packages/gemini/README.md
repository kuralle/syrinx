# @kuralle-syrinx/gemini

Google Gemini TTS for [Syrinx](https://github.com/kuralle/syrinx).

> Google Gemini TTS adapter for Syrinx

```bash
npm install @kuralle-syrinx/gemini
```

`GeminiTTSPlugin` synthesises replies through Gemini's TTS API.

```ts
import { GeminiTTSPlugin } from '@kuralle-syrinx/gemini';
session.registerPlugin('tts', new GeminiTTSPlugin());
// plugins config: { api_key: process.env.GOOGLE_GENERATIVE_AI_API_KEY }
```

Uses `GOOGLE_GENERATIVE_AI_API_KEY` (or `GEMINI_API_KEY`).

## License

MIT
