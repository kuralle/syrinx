# @kuralle-syrinx/server-websocket

Node WebSocket voice host for [Syrinx](https://github.com/kuralle/syrinx).

> Node WebSocket voice host for Syrinx — browser transport plus Twilio/Telnyx/SmartPBX telephony adapters, background audio, admission control

```bash
npm install @kuralle-syrinx/server-websocket
```

Hosts a Syrinx session over WebSocket on Node: the browser transport plus
Twilio, Telnyx and SmartPBX telephony adapters.

```ts
import { createVoiceWebSocketServer } from '@kuralle-syrinx/server-websocket';

const server = await createVoiceWebSocketServer({
  port: 4173,
  path: '/ws',
  createSession: () => buildYourAgent(),   // one session per connection
});
```

`createSession` is the seam — the host owns transport, framing, resume and graceful
drain; you own the agent.

| Subpath | For |
| --- | --- |
| `./edge` | the Workers/Durable Object runner (shared with `server-workers`) |
| `./edge-twilio` | Twilio media streams on the edge |
| `./edge-telnyx` | Telnyx media streams on the edge |
| `./session-store` | resumable session state |

## License

MIT
