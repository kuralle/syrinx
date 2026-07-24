# Example: building a custom TTS provider for Syrinx

This package is a **worked example** of how to add your own streaming Text-to-Speech provider to
Syrinx and hook it into a voice session. It was originally the `Epsilon` adapter (a bespoke
multiplexed-WebSocket TTS for a Sinhala model); that endpoint is offline, so the package is no longer
published — it lives here as a reference template.

> **Why this and not a real vendor?** Real vendors are first-class packages (`@kuralle-syrinx/cartesia`,
> `@kuralle-syrinx/elevenlabs`, `@kuralle-syrinx/deepgram`, …). This example exists to show the *seam*
> so you can wire an in-house / self-hosted TTS. Copy `src/`, swap the wire protocol, done.

## The two building blocks you reuse (don't reinvent)

- **`@kuralle-syrinx/ws` — the transport.** One long-lived `WebSocketConnection` per session with
  auto-reconnect (exponential backoff), verify-before-trust, keepalive, and replay-on-reconnect. You
  never hand-roll reconnect logic.
- **`@kuralle-syrinx/tts-core` — the streaming lifecycle.** `startStreamingTtsSession` owns per-request
  carry, refcount completion, finish-timeout, cancellation, and error mapping. You implement one small
  interface: `WireProtocol`.

## What you actually write: a `WireProtocol` (`src/index.ts`)

The entire provider-specific surface is the encode/decode of your wire format, keyed by an
`AttributionKey` (this is what lets one socket multiplex many concurrent requests):

| Method | Purpose |
|---|---|
| `attributionFor(contextId)` | mint a per-request key (here: `contextId:seq` so retries don't collide) |
| `encodeText(key, text)` | outbound "speak this" frame(s) |
| `encodeFinish()` / `encodeCancel(key)` / `encodeClose()` | flush / cancel one request / close the socket |
| `decode(data, isBinary)` | inbound frame → `WireEvent[]` (`audio`, `context_end`, `error`, or a `sideband`) |

**Binary audio** is supported: `decode(data, isBinary)` — when `isBinary`, parse your framing (this
example prefixes each binary frame with a 1-byte-length `request_id`; see `src/binary-frame.ts`) and
return `{ type: "audio", key, pcm }`.

**Usage metering** is emitted as a `sideband` event from `decode` on a request's `done` frame — that's
how the provider reports `usage.recorded{ stage: "tts", characters, provider, model }` without a
separate channel. Mirror this in your provider so metering/billing stays complete.

## Hooking it into a session

```ts
const plugin = new EpsilonTTSPlugin();               // your CustomTTSPlugin
await plugin.initialize(bus, { api_key, base_url, voice });
session.registerPlugin("tts", plugin);               // Syrinx routes tts.text → your plugin
```

`initialize` just wires your `WireProtocol` into `startStreamingTtsSession` with the `ws` transport,
your URL builder, and auth headers. See `src/index.ts` `initialize()`.

## Run the tests (they double as the spec)

```bash
pnpm --filter @kuralle-syrinx/epsilon test
```

The tests exercise encode/decode, multiplexing, cancellation-not-billed, and the usage sideband — a
good checklist for your own provider.
