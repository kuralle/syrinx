# @kuralle-syrinx/ws

Reconnecting WebSocket manager for [Syrinx](https://github.com/kuralle/syrinx).

> Reconnecting WebSocket connection manager for Syrinx provider sockets — verify-before-trust reconnects, ordered replay, keepalive; Node and Workers

```bash
npm install @kuralle-syrinx/ws
```

Provider sockets drop. This reconnects them without corrupting the stream:
**verify-before-trust** reconnects, ordered delivery, and backpressure.

```ts
import { WebSocketConnection } from '@kuralle-syrinx/ws/node';
```

| Subpath | Runtime |
| --- | --- |
| `./node` | Node (`ws`) |
| `./web` | browsers |
| `./workers` | Cloudflare Workers |
| `./realtime` | speech-to-speech provider sockets |

"Verify before trust" means a reconnected socket is not treated as usable until the
provider has confirmed the session — otherwise frames are written into a socket that
is open but not yet listening, and are silently lost.

## License

MIT
