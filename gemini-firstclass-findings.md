# Gemini Live first-class parity — findings

## Summary

Gemini Live now matches gpt-realtime on adapter unit tests, barge-in capability gating, CF worker front selection, and live smoke script coverage. Build + unit tests verified; live smokes and deploy left to manager.

## Changes

### Gap 1 — unit tests

- **`packages/realtime/src/from-gemini-live.test.ts`** — mocks `@google/genai` `live.connect`, drives `onmessage` with fake `LiveServerMessage`s, asserts:
  - `serverContent.modelTurn.parts[].inlineData` → `{type:"audio", pcm16, sampleRateHz:24000}`
  - `toolCall.functionCalls[]` → `{type:"tool_call", ...}`
  - `serverContent.interrupted` → `{type:"speech_started"}`
  - `serverContent.turnComplete` → `{type:"response_done"}`
  - input/output transcription → `{type:"transcript", role, ...}`
  - client `sendAudio` / `injectToolResult` wire-up
  - caps include `emitsServerSpeechStarted: true`

- **`packages/realtime/src/gemini-translate.test.ts`** — asserts 100ms coalescing (5×640-byte 20ms frames → one 3200-byte `sendRealtimeInput`), remainder flush on `signalAudioStreamEnd()` and `close()`.

### Gap 2 — `emitsServerSpeechStarted` cap + bridge gating

- Added `emitsServerSpeechStarted: boolean` to `RealtimeAdapter.caps`.
- `fromOpenAIRealtime`: `true` (maps `input_audio_buffer.speech_started`).
- `fromGeminiLive`: `true` (maps `interrupted` → `speech_started`).
- `fromGrokRealtime`: `false` (no provider speech_started).
- `RealtimeBridge.onSpeechStarted` gated on `adapter.caps.emitsServerSpeechStarted`.
- `realtime-bridge.test.ts`: cap-false path does not emit `interrupt.detected`.

### Gap 3 — CF Gemini front variant

- **`packages/server-workers/src/live-realtime-session.ts`**:
  - `REALTIME_FRONT=gemini|openai` (default `openai`)
  - `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL` env vars
  - `resolveRealtimeFront()`, updated `hasRealtimeSessionCredentials()`
  - Gemini path: `fromGeminiLive({ apiKey, model, systemInstruction, tools:[ASK_UNIVERSITY_TOOL] })`
  - OpenAI path unchanged (gpt-realtime + kuralle reasoner)

### Gap 4 — smoke scripts (built, not run)

- **`examples/02-hello-voice-headless/scripts/run-realtime-gemini-bargein-smoke.ts`** — Gemini front + kuralle back; mid-response barge-in gate (mirrors `run-realtime-bargein-smoke.ts`).
- **`examples/02-hello-voice-headless/scripts/run-realtime-gemini-multiturn-smoke.ts`** — 2-turn session; turn 1 states name/program, turn 2 recalls via kuralle memory.
- Package scripts: `smoke:realtime-gemini-bargein`, `smoke:realtime-gemini-multiturn`.

## Manager commands (live verification)

### Unit / build (already green)

```bash
pnpm -C packages/realtime typecheck
pnpm -C packages/realtime test
pnpm -C examples/02-hello-voice-headless typecheck
REALTIME_FRONT=gemini pnpm -C packages/server-workers exec wrangler deploy --dry-run -c wrangler.realtime.jsonc
```

### Live smokes (manager runs)

```bash
# Requires repo-root .env: GEMINI_API_KEY, CARTESIA_API_KEY (multiturn fixture synthesis)
pnpm -C examples/02-hello-voice-headless smoke:realtime-gemini-bargein
pnpm -C examples/02-hello-voice-headless smoke:realtime-gemini-multiturn
```

### CF deploy — Gemini front (manager runs)

```bash
cd packages/server-workers

# Set worker vars (non-secret)
wrangler deploy -c wrangler.realtime.jsonc \
  --var REALTIME_FRONT:gemini \
  --var GEMINI_LIVE_MODEL:gemini-3.1-flash-live-preview

# Secrets
wrangler secret put GEMINI_API_KEY -c wrangler.realtime.jsonc
# Keep OPENAI_API_KEY if switching back; VECTORIZE binding is in wrangler.realtime.jsonc
```

To revert to gpt-realtime front: set `REALTIME_FRONT=openai` (or unset) and ensure `OPENAI_API_KEY` secret is present.

## Proof

See `.handoff/proof-gemini-firstclass.json` — unit tests (31 pass), typecheck clean, wrangler dry-run bundles Gemini path.

## Manager live-verification (2026-06-10)
- **Unit tests:** ✅ 31/31 pass (`packages/realtime`, incl. from-gemini-live.test.ts + gemini-translate.test.ts + bridge cap-gating test).
- **`emitsServerSpeechStarted` cap + bridge gating:** ✅ in code + test.
- **Barge-in (live, Gemini front + kuralle):** ✅ PASS — `{ok:true, interruptCount:2, postBargeBytes:51226}`.
- **Multi-turn (live):** ⚠️ smoke flakes on `tts.end` timeout chaining two full live realtime turns
  (known B-01 class — "second turn timeout"; not a kuralle/memory defect — memory continuity is proven
  at the cascade level, run-kuralle-memory-smoke). The smoke's fixture synth was also Cartesia (402);
  manager repointed it to Deepgram TTS.
- **CF deployment:** ❌ **Gemini front does NOT run on Cloudflare Workers.** Deployed
  `syrinx-voice-realtime-gemini` (REALTIME_FRONT=gemini); `/health` ok, but a driven turn idle-times-out
  (60s, no audio) and the worker logs show `/ws … Canceled`. ROOT CAUSE: `fromGeminiLive` lets
  `@google/genai` open its OWN WebSocket, which is NOT Workers-runtime-native — unlike `fromOpenAIRealtime`
  which uses the injectable `createWorkersSocket`. **Fix (real follow-up):** make `fromGeminiLive` use a
  Workers-compatible socket (hand-roll BidiGenerateContent over `createWorkersSocket`, or inject a custom
  WS into the SDK). Until then: Gemini front is **Node-only**; gpt-realtime remains the edge front.

## Honest first-class verdict
Gemini Live front is **first-class on Node/local** (unit-tested, barge-in live, bi-model live). **Not yet
on Cloudflare** (SDK WS transport gap above). Multi-turn smoke needs the chained-realtime-turn orchestration
hardened (shared with the gpt-realtime live-resume flake). gpt-realtime still has the edge.
