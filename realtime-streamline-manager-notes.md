# Realtime adapter streamline + Cloudflare seam — manager notes

Goal: execute the thermo-nuclear review's headline code-judo (extract the shared OpenAI-compatible realtime
base; collapse the ~80% duplication between the OpenAI + Grok adapters) AND make the Cloudflare/Workers seam
solid. Worker: cursor. Manager reviewed each diff + ran suites + live regression on both providers.

## Chunks
| Chunk | Status | Gate |
|---|---|---|
| 1 — extract shared base | ✅ done | realtime 24/24 + grok 11/11; live OpenAI + Grok `ok` |
| 2 — Cloudflare seam | ✅ done | realtime 25/25 + grok 13/13; workers-seam fetch-upgrade test |

## Chunk 1 — the extraction (behavior-preserving)
- New `packages/realtime/src/openai-compatible-realtime.ts` (365) = the shared base
  (`createOpenAiCompatibleRealtimeAdapter`): RealtimeEventStream (now defined ONCE), socket open/close,
  `handleServerMessage` mapping, the response-sequencing gate (activeResponse/pendingResponseCreate), sendAudio,
  cancelResponse (truncate gated by `supportsTruncate`), injectToolResult. New `base64.ts` (16, shared).
- `from-openai-realtime.ts` 423→**103**, `from-grok-realtime.ts` 365→**93** — both now thin config
  (defaultModel, caps, buildSessionUpdate, supportsTruncate, requiresResponseCreateAfterToolOutput). grok's
  `base64.ts` deleted; grok imports the base from `@kuralle-syrinx/realtime`. Public API + option types unchanged.
- Verified: typecheck 0; suites green (assertions intact); **live OpenAI bi-model `ok` + Grok realtime `ok`
  (818KB)** — runtime behavior preserved on both providers through the new base.
- Net: the same fix no longer has to be applied to two files (the exact trap from the prior wave is gone).

## Chunk 2 — Cloudflare seam
- `packages/realtime/src/workers-seam.test.ts`: constructs `fromOpenAIRealtime({socketFactory: createWorkersSocket})`
  against a mocked workerd `fetch`; asserts the upgrade hits `https://…` (not `wss://`), carries
  `Authorization: Bearer`, calls `accept()`, and round-trips a `response.output_audio.delta` → `audio` event.
  Proves the realtime adapter composes with the Workers outbound socket.
- `packages/grok/src/edge-safety.test.ts`: source-scan (no `Buffer.`/`process.`/`node:`) + functional round-trip.
- `packages/grok/README.md`: Workers wiring section (createWorkersSocket + env-binding injection).
- edge.ts base64 consolidation: **skipped, justified** — `server-websocket` doesn't dep `@kuralle-syrinx/realtime`;
  adding a dep just for base64 is wrong scope. Right future home = `@kuralle-syrinx/core` (server-websocket already
  deps core); deferred as a tiny core-hygiene task, not done here.

## Known issue (measured, not a blocker)
One transient grok-suite failure observed ONCE during a concurrent `pnpm -r typecheck`+test run; NOT reproduced
in 8 subsequent runs (5 isolation + 3 under load). Consistent with the pre-existing rare timing-flake class
(KI-3-01: polling `waitFor`/`setTimeout` tests). Not introduced by this work. Fix if it recurs: make the
polling tests event-driven / fake-timers.

## State
typecheck 0; realtime 25, grok 13, ws 18. Not committed (awaiting "commit and push").
