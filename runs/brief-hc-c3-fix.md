# Brief — Half-cascade C3 FIX: break the syrinxTurns response feedback loop

Worker task on branch `feat/half-cascade`. Your C3 (syrinxTurns) has a live-confirmed infinite-response
loop. Fix it + add the regression test that the original unit test missed.

## Standards (hard)
- No workarounds, root-cause only. No done without the verify commands passing.
- Touch ONLY `packages/realtime/src/realtime-bridge.ts` + `realtime-bridge.test.ts`.

## Root cause (confirmed by a live smoke — 24 responses generated for one turn)
`RealtimeBridge.onResponseDone` pushes an `eos.turn_complete` packet (the textOnly branch added in C1).
In `syrinxTurns` mode the bridge ALSO subscribes to `eos.turn_complete` to call `adapter.requestResponse`.
So every provider response that COMPLETES makes the bridge emit `eos.turn_complete`, which its own
subscription turns into another `requestResponse` → another response → … an infinite loop.

The authoritative "user turn ended" `eos.turn_complete` in syrinxTurns mode comes from Syrinx's ENDPOINTING
(which triggered the response in the first place). The bridge must not ALSO emit one when its response
finishes.

## Fix
In `onResponseDone`, the `textOnly` branch currently does roughly:
```ts
if (this.opts.textOnly) {
  bus.push(Route.Main, turnComplete);   // eos.turn_complete
  return;
}
```
Guard that push so it does NOT fire in syrinxTurns mode:
```ts
if (this.opts.textOnly) {
  if (!this.opts.syrinxTurns) bus.push(Route.Main, turnComplete);
  return;
}
```
(In syrinxTurns the session already processed the endpointing's eos.turn_complete; re-emitting here both
double-books the turn and creates the loop.) Native + textOnly-without-syrinxTurns behavior unchanged.

## Red gate FIRST (this is the test the loop slipped through)
`realtime-bridge.test.ts` — new test, `syrinxTurns` mode:
1. Push ONE external `eos.turn_complete` → `adapter.requestResponse` called once.
2. Now simulate a FULL provider response cycle: `adapter.emit({type:"response_started"})`,
   `adapter.emit({type:"transcript", role:"assistant", text:"hi", final:true})`,
   `adapter.emit({type:"response_done"})`.
3. Assert `adapter.requestResponseCalls` is STILL 1 — the response completing did NOT re-trigger it.
   (Before the fix this would be ≥2 and climbing.)
Keep the existing C3 tests passing.

## Verify (write exit codes to `runs/proof-hc-c3-fix.txt`)
```
pnpm --filter @kuralle-syrinx/realtime typecheck
pnpm --filter @kuralle-syrinx/realtime test
```
Do not commit or push. Report exit codes + the new test name.
