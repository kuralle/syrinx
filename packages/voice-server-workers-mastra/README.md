# @asyncdot/voice-server-workers-mastra

A **dedicated Cloudflare Worker Durable Object** that runs a Mastra `Agent` for **human-in-the-loop suspend/resume** across voice turns. It pairs Mastra's own snapshot storage (`@mastra/cloudflare` `CloudflareDOStorage` on `ctx.storage.sql`) with a tiny `{contextId → runId}` pointer store and the [`ReasoningBridge`](../voice-bridge-aisdk/README.md).

This is **separate from** the lean AI-SDK product worker (`@asyncdot/voice-server-workers`), which stays Mastra-free + edge-bundle-clean. Mastra (≈8 MB, `nodejs_compat`) is quarantined here.

## How it works

```
turn 1 (/suspend):  agent.stream(...) → tool-call-suspended
   ReasoningBridge → llm.done(question) + reasoning.suspended packet
   DurableObjectRunStore.save(contextId, runId)          // pointer in reasoning_run_pointers
   Mastra snapshot persisted in CloudflareDOStorage      // mastra_workflow_snapshot

   ── DO may hibernate between turns ──

turn 2 (/resume):  RunStore.takePending(contextId) → runId
   bridge builds ReasonerTurn.resume → agent.resumeStream(data, {runId})
   Mastra reloads the snapshot from ctx.storage.sql on a fresh instance → completes
   RunStore.discard(contextId)
```

`DurableObjectRunStore` (`src/durable-run-store.ts`) implements the bridge's `RunStore` interface over `ctx.storage.sql` (`reasoning_run_pointers(context_id PK, run_id, created_at_ms)`), with TTL-GC via a DO alarm — mirroring `DurableObjectSessionStore`.

## Deploy

```bash
pnpm --filter @asyncdot/voice-server-workers-mastra exec wrangler deploy
wrangler secret put OPENAI_API_KEY   # real model; absent → deterministic stub (tests)
```

`wrangler.toml` sets `compatibility_flags = ["nodejs_compat"]` + the `MastraAgentDO` SQLite DO binding. Endpoints: `/health`, `/suspend?contextId=`, `POST /resume?contextId=` (`{userText}`).

## Requirements & gotchas

- **`nodejs_compat`** — `@mastra/core` needs Node builtins; bundle via **wrangler** (it handles the `.wasm` + node polyfills), not raw esbuild.
- **Workers Paid tier** — the bundle is ~8 MB (exceeds the 3 MiB Free limit; within the 10 MiB Paid limit). A bundle diet to reach Free is backlog (RFC §9, B-05).
- **No filesystem on edge** — the Mastra agent must **not** use `fs`/workspace tools (`@mastra/core` bundles `fs`/`@ast-grep/napi`, but they fail on Workers if exercised).
- **Mastra owns the checkpoint**, we own the pointer — cross-turn resume works because `CloudflareDOStorage` persists the snapshot durably in the DO's SQLite (proven across a fresh instance over the same SQL).

## Tests

The workerd two-turn suspend→resume test is opt-in (slow — spins `wrangler unstable_dev`):

```bash
SYRINX_MASTRA_EDGE_TEST=1 pnpm --filter @asyncdot/voice-server-workers-mastra test
```

It uses a deterministic stub model (no network).
