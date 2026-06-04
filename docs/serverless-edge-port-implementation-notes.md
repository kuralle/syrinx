Assumptions
- The Workers app must prove that the Syrinx browser transport pipeline boots and drives a turn inside a Durable Object without statically loading Node-only websocket/server/native modules.
- Provider credentials are application-specific, so the worker package includes a deterministic stub session for runtime proof and exposes the DO/transport seams for a real host to inject a production `VoiceAgentSession`.

Decisions
- Keep the existing Node websocket server untouched for Node callers and add edge-only subpaths instead of in-body runtime guards.
- Make provider socket defaults lazy in `initialize()` so importing a provider on edge does not pull `@asyncdot/voice-ws/node`.
- Use a PCM-only edge browser transport. The existing Opus browser transport still lives on the Node subpath because its `@evan/opus` loader is not edge-safe.
- Represent Durable Object alarm callbacks with stable scheduler keys. The DO scheduler persists deadlines in `ctx.storage.sql` and exposes `runDue()` for `alarm()`.

Root Causes Fixed
- `WS-NODE-01`: provider plugins no longer statically import `@asyncdot/voice-ws/node`; Node defaults resolve lazily at initialization time only when no socket factory was injected.
- `WS-01/02/03`: Workers inbound upgrade now uses `WebSocketPair` through `@asyncdot/voice-ws/workers`, with a controlled managed socket for Durable Object hibernation callbacks.
- `NATIVE-01/FS-01`: `@asyncdot/voice-vad-silero/workers` uses `onnxruntime-web` and model bytes/URL instead of `onnxruntime-node` and filesystem paths.
- `NATIVE-02` static-build prong: Smart Turn no longer statically imports `@huggingface/transformers`; feature extraction is loaded during predictor initialization.
- `TIMER-*`: long-lived watchdog/fallback/playout/keepalive timers route through the `Scheduler` seam; the Workers implementation persists alarm deadlines in DO SQL.
- `STATE-01/02`: the Workers app uses `DurableObjectSessionStore` backed by `ctx.storage.sql` for session metadata and resume-window retention.
- `WS-05/06/NODE-01`: the new Workers entrypoint imports only the edge subpath, so Node graceful-drain and `wsServer.clients` remain Node-only.

Verification Notes
- `pnpm -r typecheck` passed.
- `pnpm -r test` passed after replacing Telnyx fixed sleeps with condition waits; the failing recursive runs exposed pre-existing timing-sensitive tests under workspace load.
- `bash scripts/verify-edge-bundle.sh` passed for the worker bundle and a Cartesia provider bundle.
- `pnpm --filter @asyncdot/voice-server-workers test` passed, including Miniflare/workerd WebSocket turn smoke and DO scheduler/store tests.
- `pnpm --filter @asyncdot/voice-server-workers exec wrangler deploy --dry-run` passed with the DO binding and migration config.
