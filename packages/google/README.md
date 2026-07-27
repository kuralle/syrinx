# @kuralle-syrinx/google

Google Cloud Speech-to-Text v2 for [Syrinx](https://github.com/kuralle/syrinx).

> Google Cloud Speech-to-Text v2 STT adapter for Syrinx

```bash
npm install @kuralle-syrinx/google
```

`GoogleSTTPlugin` transcribes the caller through Speech-to-Text v2 streaming
recognition.

```ts
import { GoogleSTTPlugin } from '@kuralle-syrinx/google';
session.registerPlugin('stt', new GoogleSTTPlugin());
```

Authenticates with Google Cloud credentials rather than a bare API key — a service
account, not `GOOGLE_API_KEY`.

## License

MIT
