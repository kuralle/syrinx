# WBS — InteractionPolicy seam + VAP

> Spec: `docs/rfc-interaction-policy-seam.md`. Build branch: `plan/interaction-policy` (off `beta`).
> IC: grok (`/delegate --mode impl --worker grok`). Manager verifies every chunk by re-running the
> claimed commands (exit codes authoritative) + reading the diff + building a repro for the untested
> path. Manager runs any live smoke.

## Premise-check (Explore, 2026-07-09 vs beta HEAD 7adbb32) — verdict

Unlike the prior three vNext RFCs, this one is **mostly NOT stale** — the author already accounted for
the IU substrate and correctly gated C5's full-duplex mode on the un-landed reshape.

| Chunk | Verdict | Action |
|-------|---------|--------|
| C1 (seam + RuleBasedInteractionPolicy, barge-in) | INTACT | build-as-specced, turn-scoped |
| C2 (caps + DeferInteractionPolicy) | INTACT | build-as-specced |
| C3 (backchannels) | INTACT | build-as-specced |
| C4 (rich SttPartialPacket) | INTACT | build + also read existing `stt.interim` |
| C5 (VAP ONNX) | PARTIAL | build turn-scoped; **DEFER full-duplex mode to B-05** |
| C6 (eval harness) | INTACT | trailing proof gate |

Evidence anchors + the confirmed **B-05 block** (packets carry only `contextId`+`timestampMs`; epoch is
not first-class → full-duplex no-boundary mode blocked) are in
`runs/interaction-policy-implementation-notes.md`.

## Chunk-boundary refinement (manager decision D-4, logged)

RFC C1 bundles two behavior-preserving reshapes: **barge-in** (TurnArbiter path) and **endpointing**
(the `endpointingOwner` provider_stt|smart_turn|timer branches). Splitting them isolates risk and lets
each be verified against its strongest guard. **Same total scope**, split for verifiability — not a
scope change. So:

- **C1** = the seam + coordinator + `RuleBasedInteractionPolicy`, routing **barge-in** through it.
- **C1b** = collapse the `endpointingOwner` branches behind the seam (coordinator maps `take_turn`).

## C1 design (locked — the barge-in seam)

The RFC's pure `observe() -> InteractionDecision[]` seam conflicts with today's bus-emitting
`TurnArbiter`. Reconcile at lowest risk:

- **`TurnArbiter` stays the RuleBased barge-in decision engine, behavior-identical by default.** It gains
  an **optional interrupt sink** (`onInterrupt?`). Absent → today's `bus.push(interrupt.detected)`
  (byte-identical → `turn-arbiter.test.ts` green **unchanged**). Present → the arbiter routes its
  *autonomous-commit* interrupt through the sink instead of pushing `interrupt.detected` (the Background
  metrics still push exactly as today). The public executor methods (`emitInterruptDetected`,
  `commitClientInterrupt`) keep pushing to the bus — they are the executor the session/coordinator call
  directly (latency filler cancel `vas.ts:996`, client interrupt `vas.ts:483`), per RFC §5.1.
- **`RuleBasedInteractionPolicy implements InteractionPolicy`** — constructs/holds the arbiter with the
  sink, buffers `interrupt` decisions, drains them from `observe()`. `reset(contextId)` → `arbiter.clear()`.
- **`InteractionCoordinator`** — subscribes to the signals the session currently routes to the arbiter
  (`vad.speech_started|speech_activity|speech_ended|audio`, `stt.interim`, `stt.result`), builds
  `InteractionObservation`s, calls `policy.observe`, maps `interrupt` → `bus.push(interrupt.detected)`
  (the exact packet the arbiter emitted). The session stops driving the arbiter for these signals.
- **Net session bus output is identical → `turn-arbiter.characterization.test.ts` stays green unchanged**
  (REQ-8, the guard). A future `VapInteractionPolicy` returns the same `interrupt` decisions → real seam.

Arbiter touch-points to relocate into the coordinator (all in `voice-agent-session.ts`):
`noteInterimEvidence` (651,669), `observeBargeInAudio` (691), `onProviderSttEvidence`/`maybeBargeInFromProviderStt`
(710-716), `onSpeechStarted` (745), `onSpeechActivity` (749), `onSpeechEnded` (768), `clear` (449 close +
the `turn.change` handler ~551). Left as direct executor calls: `commitClientInterrupt` (483),
`emitInterruptDetected` (996). The provider-STT-barge-in enablement gate (`endpointingOwner==="provider_stt"`,
711) stays owner-conditional for now (moves in C1b).

## Sprints

| # | Chunk | Files | Status |
|---|-------|-------|--------|
| C1 | Seam + coordinator + RuleBasedInteractionPolicy (barge-in) | `packages/core/src/interaction-policy.ts`, `interaction-coordinator.ts`, `policies/rule-based.ts`, `turn-arbiter.ts` (add sink), `voice-agent-session.ts` (relocate wiring), `index.ts` (exports) | todo |
| C1b | Endpointing owners behind the seam (`take_turn`) | `voice-agent-session.ts`, `rule-based.ts`, `interaction-coordinator.ts` | todo |
| C2 | caps.supportsFullDuplex/emitsBackchannel + DeferInteractionPolicy | `packages/realtime/src/realtime-adapter.ts`, `realtime-bridge.ts`, `packages/core/src/policies/defer.ts` | todo |
| C3 | Backchannels via BackgroundAudioMixer | `packets.ts`, `packages/server-websocket/src/*`, `packages/cf-agents/src/with-voice.ts` | todo |
| C4 | Rich-typed SttPartialPacket (wordTimings) | `packets.ts`, `packages/deepgram/src/stt.ts`, coordinator | todo |
| C5 | @kuralle-syrinx/vap VapInteractionPolicy (turn-scoped; full-duplex → B-05) | `packages/vap/*` (new) | scope |
| C6 | Eval harness (proof gate) | `packages/test/*` or `scripts/eval/*` | scope |

## Universal Definition of Done (every chunk)
- Atomic commit on `plan/interaction-policy` behind green `pnpm --filter @kuralle-syrinx/core typecheck && test`
  (+ any other touched package). No push, no main.
- Behavior-preserving reshapes keep existing characterization tests **unchanged** (RFC §11 abort otherwise).
- Every new public surface has a happy + failure-path test.
- Manager proceed evidence (re-run claimed commands; exit codes authoritative; read the diff; build a
  repro for the untested path) → PROCEED / HOLD→re-delegate-fix.
- No `--no-verify` / `@ts-ignore` / `as any` / silent catch.
