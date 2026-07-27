# @kuralle-syrinx/server-workers

Cloudflare Workers voice host for [Syrinx](https://github.com/kuralle/syrinx).

> Cloudflare Workers voice host for Syrinx — the full STT→LLM→TTS engine in one hibernatable Durable Object per session, with R2 call recording

```bash
npm install @kuralle-syrinx/server-workers
```

The full STT→LLM→TTS engine in one **hibernatable Durable Object per
conversation** — the same session that runs on Node, on Cloudflare's edge.

```ts
export { VoiceConversation } from '@kuralle-syrinx/server-workers';
```

Routing is the Agents SDK convention: `/agents/<class-name-in-kebab-case>/<id>`, so
`VoiceConversation` answers at `/agents/voice-conversation/<id>`. The class name in
`wrangler.jsonc` is the source of truth — never hardcode the route.

Hibernation matters for cost: an idle conversation holds no compute, and the socket
survives.

## License

MIT
