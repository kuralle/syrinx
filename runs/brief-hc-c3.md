# Brief — Half-cascade C3: Syrinx-owned turn detection (REQ-6)

Worker task on branch `feat/half-cascade` (checked out; C0+C1 are in the tree). Spec:
`docs/rfc-half-cascade.md` chunk **C3** (§3 REQ-6, §5.2). Ship finished, verified work.

## Standards (hard)
- No workarounds, no `@ts-ignore`/`as any`, root-cause only. No done without the verify commands passing.
- Touch ONLY the 3 files below + their tests. Match surrounding style.
- Command efficiency: run heavy commands ONCE, capture to a `mktemp`, inspect that.

## Context
In half-cascade text-only mode the OpenAI provider's server VAD still works, but REQ-6 requires the
option for **Syrinx to OWN turn detection** (so a VAP/InteractionPolicy or Syrinx endpointing drives turns
and barge-in, not the provider). Today the bridge appends user audio via `adapter.sendAudio` and relies on
the provider's `server_vad` to auto-commit + respond. This chunk adds the capability to instead let Syrinx's
own end-of-turn signal (`eos.turn_complete`, already emitted by the session endpointing /
InteractionCoordinator) drive the provider's response — with the provider's server VAD turned OFF.

## Changes
1. `packages/realtime/src/realtime-adapter.ts` — add to the `RealtimeAdapter` interface (near `sendText?`):
   ```ts
   /**
    * Commit any buffered user input and request a response. For Syrinx-OWNED turn detection
    * (provider server VAD disabled via turnDetection:null): the host calls this when its own
    * endpointing (InteractionPolicy / VAD) signals end-of-turn. Optional — adapters without
    * manual turn control omit it.
    */
   requestResponse?(): void;
   ```

2. `packages/realtime/src/openai-compatible-realtime.ts` — implement the public method on the adapter class:
   ```ts
   requestResponse(): void {
     this.requireSocket().send({ type: "input_audio_buffer.commit" });
     this.requestResponseCreate();
   }
   ```
   (Place it near `sendAudio` / `sendText`. Reuse the existing private `requestResponseCreate()`.)

3. `packages/realtime/src/realtime-bridge.ts` — add `readonly syrinxTurns?: boolean;` to
   `RealtimeBridgeOptions` (documented). In `initialize`, when `this.opts.syrinxTurns`, subscribe:
   ```ts
   bus.on("eos.turn_complete", () => { this.adapter.requestResponse?.(); });
   ```
   (Add its disposer alongside the other `bus.on` registrations.) Document that `syrinxTurns` MUST be paired
   with `turnDetection: null` on the adapter — otherwise the provider's server VAD and Syrinx would BOTH
   trigger responses (double-turn). Native mode (`syrinxTurns` absent/false) is byte-unchanged.

## Red gate FIRST (fail, then implement)
- `realtime-bridge.test.ts`: in `syrinxTurns` mode, pushing an `eos.turn_complete` bus packet calls
  `adapter.requestResponse` exactly once (use a mock/fake adapter that records the call). WITHOUT
  `syrinxTurns`, an `eos.turn_complete` does NOT call it.
- `openai-compatible-realtime.test.ts`: `requestResponse()` sends `input_audio_buffer.commit` then
  `response.create` (assert on the mock socket `sent` frames, in order).

## Verify (must pass; write exit codes to `runs/proof-hc-c3.txt`)
```
pnpm --filter @kuralle-syrinx/realtime typecheck
pnpm --filter @kuralle-syrinx/realtime test
```
Do not commit or push. Report exit codes + new test names.
