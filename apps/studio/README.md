# Syrinx Studio

Browser voice studio for Syrinx — connect to a local or hosted WebSocket voice backend, stream microphone audio, hear assistant playback, and watch a live transcript.

Built with Vite, React 19, TanStack Router, Tailwind, and shadcn/ui. Uses `@kuralle-syrinx/browser-client` (`SyrinxBrowserClient`) over the Syrinx WebSocket protocol (not LiveKit/WebRTC).

## Local development

1. Start the local voice backend (university support review server):

```bash
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless review:studio
```

This serves the WebSocket endpoint at `ws://127.0.0.1:4173/ws` by default.

2. In another terminal, start the studio:

```bash
pnpm --filter @kuralle-syrinx/studio dev
```

3. Open the Vite dev URL (typically `http://localhost:5173`), keep **Backend → Local**, and click **Connect**. Allow microphone access when prompted.

Override the WebSocket URL with a query param:

```text
http://localhost:5173/?ws=ws://127.0.0.1:4173/ws
```

## Hosted backend

Select **Backend → Hosted (Cloudflare)** in the UI, or set a custom URL to:

```text
wss://syrinx-voice-server-workers.mithushancj.workers.dev/ws
```

The studio is a static SPA; it connects to the separately deployed voice worker.

## Scripts

| Script | Purpose |
|--------|---------|
| `pnpm --filter @kuralle-syrinx/studio dev` | Vite dev server |
| `pnpm --filter @kuralle-syrinx/studio build` | Production build to `dist/` |
| `pnpm --filter @kuralle-syrinx/studio preview` | Preview production build |
| `pnpm --filter @kuralle-syrinx/studio deploy` | Build + deploy static assets to Cloudflare (`syrinx-studio` worker) |
| `pnpm --filter @kuralle-syrinx/studio hosted-test` | End-to-end hosted WS smoke (streams university fixture, asserts transcript) |
| `pnpm --filter @kuralle-syrinx/studio test` | Unit/component tests |

## Deploy

```bash
pnpm --filter @kuralle-syrinx/studio deploy
```

Requires Cloudflare credentials (`wrangler login`). The worker serves the SPA from `./dist` with SPA fallback routing.

## Protocol notes

- Always-on microphone uplink — server VAD/endpointing owns turn boundaries (no client VAD).
- User transcript: `stt_chunk` (interim) and `stt_output` (final).
- Assistant transcript: `agent_chunk` (streaming) finalized on `agent_end`.
- Assistant audio: binary `syrinx.audio.v1` envelopes played via the browser client jitter buffer.

See `docs/websocket-audio-protocol.md` for wire details.
