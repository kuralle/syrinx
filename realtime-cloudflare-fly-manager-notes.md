# gpt-realtime on Cloudflare + Fly WS deploy — manager notes

## Shipped + deployed
- **gpt-realtime bi-model worker on Cloudflare**: `https://syrinx-voice-realtime-workers.mithushancj.workers.dev`
  — front gpt-realtime-2 dialed OUT via `createWorkersSocket`, back = the **university Reasoner** (reused via
  the bi-model delegate loop). New `packages/server-workers/src/{live-realtime-session.ts, worker-realtime.ts,
  live-realtime-session.test.ts}` + `wrangler.realtime.jsonc` (own DO `RealtimeVoiceConversation`).
  `OPENAI_API_KEY` set as a worker secret.
- **Fly.io WS deploy**: `https://syrinx-studio-mcj.fly.dev` redeployed (`--no-cache`, single machine via
  `--ha=false`, spike defaults already in `fly.studio-spike.toml`: auto-stop, min_machines_running=0). The
  app was 2 days stale (pre-fixes); redeploy brought the envelope/transport fixes onto Fly too.
  `/healthz` → `{"ok":true}` HTTP 200. Serves the cascade studio (index.html + /ws) over wss.

## Live-verified (deterministic envelope probe → the deployed realtime worker)
- Voice round-trips: audio in → gpt-realtime-2 → audio out (~677 KB).
- **Assistant transcript surfaces** (bi-model): "…let me check your add-deadline… You can still add Biology
  101 after the deadline by submitting a Late Add Petition…" — front lead-in + grounded reasoner answer.
- Bi-model delegation works (the answer is grounded by the university reasoner, not hallucinated).

## Bugs fixed this wave
- **realtime-bridge `resamplePcm16Bytes`** did `new Int16Array(buf, byteOffset, …)` → threw
  "start offset … multiple of 2" on the realtime path (decoded envelope payload sits at an ODD byteOffset;
  cascade dodged it at 16k→16k). Fixed: use `pcm16BytesToSamples` (DataView, offset-safe) + drop a trailing
  odd byte (matches the prior truncating view; keeps R-12 "never emit odd-length tts.audio" green).
- **Assistant transcript not surfaced** as agent text → studio showed no assistant bubble on realtime. Fixed:
  the bridge accumulates the assistant final transcript and emits `llm.delta` + `llm.done` in `onResponseDone`
  (→ `agent_chunk`/`agent_end`). Realtime suite stays 25/25 (turn lifecycle intact).
- **User input transcription**: enabled `inputTranscription: true` on the worker adapter + added the
  `conversation.item.input_audio_transcription.completed` → user `transcript` mapping in the adapter.

## Studio fixes (deployed, studio 1dd00e44)
- "Printed twice": `stt_output` segments now coalesce into ONE user bubble per turnId (Deepgram emits several
  is_final segments per utterance).
- Read-only URL box: now editable (typing a hosted URL switches target to custom; no longer locked while connected).

## Known gap (honest)
- **Realtime USER transcript text is still empty** in the studio. The adapter now maps the input-transcription
  event, and the worker enables it, but gpt-realtime-2 isn't emitting `…input_audio_transcription.completed`
  in practice — a model-specific transcription config nuance (whisper-1 vs gpt-4o-transcribe, or a different
  event name). Needs a LIVE raw-event trace against gpt-realtime-2 to pin; not blind-guessed. Voice + assistant
  transcript + bi-model grounding all work; only the user-side text bubble is missing on the realtime path.

## Endpoints
| What | URL |
|---|---|
| Studio (frontend) | https://syrinx-studio.mithushancj.workers.dev |
| Cascade worker | https://syrinx-voice-server-workers.mithushancj.workers.dev/ws |
| Realtime bi-model worker | https://syrinx-voice-realtime-workers.mithushancj.workers.dev/ws |
| Fly cascade (wss) | https://syrinx-studio-mcj.fly.dev (/ws) |
