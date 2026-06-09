# G5 production hardening — findings

Three hardening tracks for voice production readiness: barge-in memory reconciliation, one-utterance flow turns, and edge worker auth.

## G5a — barge-in ↔ kuralle memory reconciliation

**Verdict: implemented in bridge (no first-class kuralle truncate API).**

Investigation of `@kuralle-agents/core` 0.7.1: `SessionStore` exposes `get`/`save` only; `VoiceDriver` truncates on native voice interrupt, but the `TextDriver` path used by the syrinx bridge does not. There is no runtime hook to edit a single in-flight assistant turn.

**Bridge fix** (`packages/kuralle/src/from-kuralle.ts`):
- On abort (`turn.signal.aborted`), after the turn handle settles, `reconcileSpokenPrefix()` rewrites the last assistant message in both `session.messages` and `durableRuns[*].runState.messages` to the accumulated spoken prefix (`acc`).
- Unit tests cover `rewriteLastAssistant`, durable-run rewrite, and flow-resume run-option shaping.

**Upstream API that would make this cleaner:** `SessionStore.patchMessage(sessionId, index, content)` or a `runtime.reconcileAssistantTurn(sessionId, spokenPrefix)` hook invoked by channel drivers on interrupt.

## G5b — one utterance per flow turn (examples)

**Verdict: fixed via flow authoring + bridge flow-resume input shaping.**

### Flow authoring (`examples/02-hello-voice-headless/src/university-agent-full.ts`)
- Replaced `{goto}` multi-node chains with phase-aware single `reply` nodes per flow (`bookingTurn`, `transcriptTurn`).
- `next()` merges tool results into state and returns `'stay'` until the next user turn.

### Root cause of double utterances
With `activeFlow` set, kuralle `openRun({ input })` queues user text as `__v2_pendingUserInput`. The first `dispatchNode` runs `runAgentTurn` **before** pending input is consumed; on `'stay'`, `runFlow` consumes pending and **re-dispatches in the same turn** → 2+ `text-start` blocks.

Using kuralle's `historyDelta` avoids pending double-dispatch but user messages were not reliably visible to the model on flow resume (persisted `runState.messages` tail lacked the delta after the turn).

**Bridge fix:** when `activeFlow` is set, `appendFlowResumeUserMessage()` pre-appends the user turn to `session.messages` and `durableRuns[sessionId].runState.messages`, clears stale `__v2_pendingUserInput`, then calls `runtime.run()` with **no** `input`/`historyDelta`. One dispatch, one utterance, tools fire.

### Smoke proof (`pnpm -C examples/02-hello-voice-headless smoke:kuralle-full-text`)

All T1–T6: **1 text-start per turn**. Hard asserts: **ADV-1**, **TR-S12345** pass.

```
T4: 1 utterance, record_booking_details → confirm prompt
T5: 1 utterance, create_booking → "ADV-1"
T6: 1 utterance, enter_flow + request_transcript → "TR-S12345"
```

(Full trace in `.handoff/proof-hardening-smoke.stdout`.)

## G5c — worker endpoint auth

**Verdict: implemented on all three CF edge workers.**

| Worker | Protected routes | Open routes |
|--------|------------------|-------------|
| `apps/kuralle-edge` | `GET /chat` | `GET /health` |
| `apps/kuralle-edge-vectorize` | `POST /chat`, `POST /ingest` | `GET /health` |
| `apps/kuralle-edge-aigateway` | `POST /chat`, `POST /ingest` | `GET /health` |

Gate: header `x-edge-token: <EDGE_TOKEN>` must match `env.EDGE_TOKEN`; otherwise **401**.

**Local dev:** `EDGE_TOKEN=dev-edge-token` in each app's `.dev.vars`.

**Production secret:**
```bash
wrangler secret put EDGE_TOKEN --config apps/kuralle-edge/wrangler.toml
wrangler secret put EDGE_TOKEN --config apps/kuralle-edge-vectorize/wrangler.toml
wrangler secret put EDGE_TOKEN --config apps/kuralle-edge-aigateway/wrangler.toml
```

Clients must send `x-edge-token: <same value>` on `/chat` and `/ingest`.

**Typecheck:** all three workers pass `npx tsc --noEmit` (vectorize workers use `VectorizeBinding` cast for `@cloudflare/workers-types` version skew vs `@kuralle-agents/vectorize-store`).

## Proof

Cryptographic verification: `.handoff/proof-hardening.json` + stdout sidecars.
