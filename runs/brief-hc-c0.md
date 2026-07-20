# Brief — Half-cascade C0: adapter surfaces text-only output

You are an implementation worker. Branch is `feat/half-cascade` (already checked out). Spec:
`docs/rfc-half-cascade.md` chunk **C0** (§4.1, §4.2, §4.4, §7). Ship finished, verified work.

## Standards (hard)
- No workarounds. No `@ts-ignore`/`as any` to silence types. Root-cause only.
- Do NOT claim done without the verification commands below passing — capture exit codes.
- Surgical: touch ONLY the three files below. Match surrounding style. No drive-by refactors.
- Command efficiency: run a heavy command ONCE, capture to a `mktemp` file, inspect that — never re-run to reshape output.

## Task
Surface the OpenAI Realtime **text-only** response so half-cascade can drive TTS from it. Today the
adapter handles `response.output_audio_transcript.delta/.done` but NOT `response.output_text.delta/.done`,
so `modalities:["text"]` sessions surface nothing spoken.

## Files + exact changes
1. `packages/realtime/src/realtime-adapter.ts` — add to the `caps` object type:
   `readonly supportsTextOnlyModality?: boolean;` (optional; absent = false).

2. `packages/realtime/src/openai-compatible-realtime.ts` — in the server-message `switch`, directly
   mirroring the existing `case "response.output_audio_transcript.delta"` / `.done` blocks
   (currently ~lines 309–333), ADD:
   - `case "response.output_text.delta":` — read `msg["delta"]`; if it is a non-empty string,
     `this.assistantTranscript += delta` and `this.stream.push({ type: "transcript", role: "assistant", text: delta, final: false })`.
   - `case "response.output_text.done":` — `const t = typeof msg["text"] === "string" ? msg["text"] : this.assistantTranscript;`
     `this.stream.push({ type: "transcript", role: "assistant", text: t, final: true })`; then `this.assistantTranscript = ""`.
   Use the SAME `transcript` event shape the audio-transcript cases already emit — introduce NO new event type.

3. `packages/realtime/src/from-openai-realtime.ts` — set the new cap in the `caps` object:
   `supportsTextOnlyModality: opts.modalities?.length === 1 && opts.modalities[0] === "text",`.

## Red gate FIRST (prove it fails, then implement)
Add failing unit tests in `packages/realtime/src/openai-compatible-realtime.test.ts` (mirror the existing
audio-transcript test) asserting that feeding `response.output_text.delta` then `.done` server messages
produces assistant `transcript` events (delta: final=false; done: final=true, accumulated text). Run them,
watch them FAIL (cases don't exist yet), then implement, then watch them PASS.

## Verify (must pass; write exit codes to `runs/proof-hc-c0.txt`)
```
pnpm --filter @kuralle-syrinx/realtime typecheck
pnpm --filter @kuralle-syrinx/realtime test
```
Do not commit or push. Leave the working tree with your changes. Report the two exit codes and the new test names.
