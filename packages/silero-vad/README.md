# @kuralle-syrinx/silero-vad

Silero voice activity detection for [Syrinx](https://github.com/kuralle/syrinx).

> Silero VAD plugin for Syrinx — ONNX voice activity detection for Node and Workers

```bash
npm install @kuralle-syrinx/silero-vad
```

`SileroVADPlugin` runs Silero VAD as ONNX inference over the inbound audio,
emitting speech-start and speech-end so the engine knows when the caller is talking.

```ts
import { SileroVADPlugin } from '@kuralle-syrinx/silero-vad';
session.registerPlugin('vad', new SileroVADPlugin());
```

Inference is **stateful**, so frames are processed strictly in order. The plugin does
not hold the pipeline bus while inferring — frames chain on an internal queue — because
awaiting it inline delayed every packet behind it, inbound audio included.

`./workers` is the Cloudflare build.

## License

MIT
