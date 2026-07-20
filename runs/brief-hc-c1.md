# Brief — Half-cascade C1: RealtimeBridge textOnly routing

Worker task on branch `feat/half-cascade` (checked out; C0 is already in the working tree). Spec:
`docs/rfc-half-cascade.md` chunk **C1** (§3 REQ-2/4/5, §4.3, §6, §7). Ship finished, verified work.

## Standards (hard)
- No workarounds, no `@ts-ignore`/`as any`, root-cause only. No done without the verify commands passing.
- Touch ONLY `packages/realtime/src/realtime-bridge.ts` and its test. Match surrounding style.
- Command efficiency: run heavy commands ONCE, capture to a `mktemp`, inspect that.

## Context (read realtime-bridge.ts first)
Today, assistant `transcript` events are BUFFERED into `turnAssistantText`/`turnAssistantDeltas`
(the `case "transcript"` block, ~lines 181-192) and emitted ONCE at `onResponseDone` (~lines 489-500)
as **display-only** `llm.delta` + `llm.done` — because in native mode the PROVIDER already produced the
audio. `onResponseDone` also force-emits `tts.end` (~line 480).

Half-cascade inverts this: there is NO provider audio; the assistant text must DRIVE Syrinx TTS. So in
text-only mode the bridge streams the transcript into the cascade `llm.delta → segmenter → tts.text → TTS`
path as it arrives, and lets the registered TTS plugin own the audio lifecycle.

## Changes (all gated on a new `opts.textOnly`)
1. Add `readonly textOnly?: boolean;` to `RealtimeBridgeOptions` (interface ~line 55), documented.

2. In the `case "transcript"` assistant branch (~lines 184-191), when `this.opts.textOnly`:
   - **non-final delta** (`!ev.final && ev.text`): immediately
     `bus.push(Route.Main, { kind: "llm.delta", contextId: this.contextId, timestampMs: Date.now(), text: ev.text })`.
     Stream it — do NOT buffer, do NOT touch `turnAssistantText`/`turnAssistantDeltas`.
   - **final** (`ev.final && ev.text.trim()`): `bus.push(Route.Main, { kind: "llm.done", contextId, timestampMs, text: ev.text })`.
     Do NOT also push `llm.delta` with the full final text (the C0 adapter's `output_text.done` carries the
     FULL accumulated text; re-emitting it would duplicate every streamed delta).
   When NOT textOnly: leave today's buffering behavior byte-unchanged.

3. In `onResponseDone` (~485-500), when `textOnly`:
   - SKIP the display-only assistant `llm.delta`/`llm.done` re-emission block (already streamed above).
   - Do NOT force-emit `tts.end` (~line 480). In text-only mode the **TTS plugin owns `tts.end`** — it fires
     when Syrinx synthesis finishes, not when the front's text ends. Forcing it here would cut playout /
     break barge-in (REQ-5). Keep the `eos.turn_complete` handling.
   (Native mode path: unchanged.)

4. Make `onAudio` (the `case "audio"` handler, ~line 178) a **no-op when textOnly** — provider audio must
   not be used (REQ-4). Do not throw; just return.

5. Do NOT add a constructor throw for "missing TTS plugin" — the bridge does not own the plugin registry.
   Document in a comment that text-only mode REQUIRES a TTS plugin registered on the session bus.

## Red gate FIRST (fail, then implement) — `packages/realtime/src/realtime-bridge.test.ts`
- textOnly: feeding assistant `transcript` deltas (final=false) pushes `llm.delta` packets with the delta
  text, in order, as they arrive.
- textOnly: a final assistant `transcript` pushes `llm.done` and NO extra full-text `llm.delta`.
- textOnly: a provider `audio` event pushes NO `tts.audio`.
- textOnly: `onResponseDone` does NOT emit a duplicate assistant `llm.delta` and does NOT emit `tts.end`.
- Non-textOnly regression: existing bridge tests still pass unchanged.

## Verify (must pass; write exit codes to `runs/proof-hc-c1.txt`)
```
pnpm --filter @kuralle-syrinx/realtime typecheck
pnpm --filter @kuralle-syrinx/realtime test
```
Do not commit or push. Report exit codes + new test names.
