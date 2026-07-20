# IP-C1b implementation brief

## Task

Finish C1b from `docs/rfc-interaction-policy-seam.md` on branch
`feat/interaction-policy-vap` (off merged `beta` at `dfa1ee2`).

## Locked outcome

1. `VoiceAgentSessionConfig.interactionPolicy` accepts a caller-supplied policy. The default remains
   behavior-compatible `RuleBasedInteractionPolicy`; `fullDuplex` remains observe-only through
   `DeferInteractionPolicy`.
2. Every valid inbound PCM16 `user.audio_received` chunk produces a synchronous `audio_frame`
   observation with correctly decoded `Int16Array` samples. Real `tts.playout_progress`, plus TTS start/end
   transitions where needed to keep state correct, produce `playout_tick` observations.
3. `InteractionCoordinator` executes `take_turn`; it is no longer a no-op. Learned policies can request STT
   finalization and complete a cascade turn without provider-specific branches. `hold` / resumed speech must
   cancel a pending delayed take-turn. Existing direct `eos.turn_complete` behavior remains byte-compatible
   for the default legacy owner path during the migration.
4. The Silero + Smart Turn v3 + semantic fusion endpointing stack is exposed as a first-class injectable
   policy from `@kuralle-syrinx/pipecat-smart-turn`, without importing that package from core. Preserve the
   existing `PipecatEOSPlugin` public path and tests.
5. Add a bounded confidence-to-wait mapping patterned after LiveKit: high EOT confidence waits about 150 ms;
   low confidence waits 1.5-2 s. The mapping must be monotonic, clamped, deterministic, and unit-tested.
6. Policy lifecycle is owned by the session when injected: initialize once during start, close once during
   close. Do not initialize or close the internal default rule policy as an external model.

## Constraints

- No provider-specific special case in core.
- `InteractionPolicy.observe` remains synchronous; learned inference stays async/off the hot path.
- No local Python. Any later Python work must run through Modal.
- Keep `endpointingOwner` as a compatibility adapter only where existing callers still require it; do not add
  a fourth owner string.
- Preserve endpointing invariant tests and provider-STT barge-in behavior.
- Do not touch the unrelated untracked `runs/metrics.jsonl`.

## Red gates

Add focused tests first and prove they fail against baseline:

- session injects a fake policy and delivers exact `audio_frame` samples;
- session delivers `playout_tick` with progress and active state;
- a fake policy `take_turn` reaches exactly one `user.input` after STT finalization;
- `hold` / speech resume revokes a delayed take-turn;
- wait curve endpoints + monotonicity;
- selectable Smart Turn policy acoustic + semantic fusion behavior using a fake predictor.

## Required verification

```sh
pnpm --filter @kuralle-syrinx/core typecheck
pnpm --filter @kuralle-syrinx/core test
pnpm --filter @kuralle-syrinx/pipecat-smart-turn typecheck
pnpm --filter @kuralle-syrinx/pipecat-smart-turn test
pnpm -r typecheck
pnpm -r test
```

Write `runs/result-ip-c1b.json` with the protocol result shape and exact claims. Do not commit or push.
