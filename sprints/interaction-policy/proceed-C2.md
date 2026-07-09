# Proceed evidence — `IP-C2` caps negotiation + DeferInteractionPolicy

**Verdict:** **PROCEED** (round 1 — no HOLD)
**Manager:** Opus 4.8 (1M), 2026-07-10
**Commit under review:** `37fa3f2` `[IP-C2]` on `plan/interaction-policy`
**Worker:** grok · **Manager guard added:** separate commit (see below)

## Verified (manager re-run, exit codes authoritative)
- `pnpm --filter @kuralle-syrinx/core typecheck` 0; `... realtime typecheck` 0;
  `... core test` 0 (**252**); `... realtime test` 0 (**51**). Matches proof json.
- **Guard tests byte-unchanged** (`turn-arbiter.test`, `characterization`): empty diff.
- Diff surgical + exactly per brief: caps `supportsFullDuplex?`/`emitsBackchannel?` (additive, optional);
  `DeferInteractionPolicy` (`observe → []`, `reset` noop); session `fullDuplex` config flag.

## The key risk — checked both directions
The observe-only wiring must suppress VAD/STT-driven decisions **without** breaking the direct executor
calls (client interrupt, latency-filler cancel). grok's wiring is correct:
```ts
const coordinatorPolicy = this.fullDuplex ? new DeferInteractionPolicy() : this.interactionPolicy;
this.interaction = new InteractionCoordinator({ bus, policy: coordinatorPolicy, executor: this.interactionPolicy.arbiter });
```
The coordinator's **drive** policy becomes Defer (returns [] → applies nothing), while the **executor**
stays the rule policy's arbiter — so `commitClientInterrupt`/`emitInterruptDetected` still work.
- **Suppression proven** (grok's test): `fullDuplex:true` + VAD speech_started + sustained activity past
  280ms → no `interrupt.tts`.
- **Executor survival proven** (manager guard, this commit): `fullDuplex:true` +
  `requestClientInterrupt("assistant-turn")` during active TTS → `interrupt.tts` **still fires**. The
  front owning turn-taking must not disable the user's explicit "stop". 253 core green.

## Scope note (logged)
Selection is by session config `fullDuplex` in this chunk; the realtime factory auto-wiring
`fullDuplex` from `RealtimeAdapter.caps.supportsFullDuplex` is an explicit follow-up (no full-duplex
adapter exists yet — the caps fields are added for that future factory). No dual shape; the policy is a
clean selection.

## Decision
**PROCEED.** The seam's capability-negotiation surface is in and correct; defer mode is proven inert for
VAD-driven decisions and intact for direct client interrupt. IP-C2 done.
