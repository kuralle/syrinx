# Story Brief — `IP-C2` caps negotiation + DeferInteractionPolicy

> **You are the IC engineer (`grok` worker — fresh process, clean context).** Self-contained. If anything
> contradicts disk, **STOP** → `.handoff/blocked-ip-c2.md`.
>
> **Branch:** `plan/interaction-policy` (already checked out; IP-C1 is committed — the seam exists).
> **Commit:** one atomic `[IP-C2] caps.supportsFullDuplex/emitsBackchannel + DeferInteractionPolicy`.
> No push, no main. **Proof:** `.handoff/proof-ip-c2.json`. **Do NOT run any live smoke.**

## 1. Goal

Add capability-negotiation for a full-duplex front and a `DeferInteractionPolicy` so that when the front
owns duplex decisions, Syrinx's coordinator runs **observe-only** (takes no bus action) — the seam's
"defer to native" mode (RFC REQ-4). Two adapter caps flags are added for a future factory to consume; the
selection itself is driven by a session config flag in this chunk.

## 2. Required reading
1. `docs/rfc-interaction-policy-seam.md` §3 REQ-4, §4.2 (`DeferInteractionPolicy`), §4.4 (caps additions).
2. `packages/core/src/interaction-policy.ts` — the `InteractionPolicy` interface + types (from IP-C1).
3. `packages/core/src/policies/rule-based.ts` — mirror its shape/packaging for the new policy.
4. `packages/core/src/voice-agent-session.ts` — where the policy is constructed (search
   `new RuleBasedInteractionPolicy(` — ~line 350). You will make that construction conditional.
5. `packages/realtime/src/realtime-adapter.ts` — the `caps` object (lines 4-17). You add two fields.

## 3. Changes

### 3a. caps additions — `packages/realtime/src/realtime-adapter.ts`
Add to the `caps` object (both optional, both after `supportsNativeResume?`):
```ts
    /** The front model owns full-duplex interaction decisions (turn-taking, barge-in). When true,
     *  Syrinx's InteractionPolicy runs observe-only and does not drive its own turn/interrupt decisions
     *  (RFC InteractionPolicy REQ-4). Absent/false → Syrinx drives. No current adapter sets this. */
    readonly supportsFullDuplex?: boolean;
    /** The front emits its own backchannels ("mhmm"). When true, Syrinx suppresses its own backchannel
     *  cues (RFC InteractionPolicy REQ-4). Absent/false → Syrinx may emit. */
    readonly emitsBackchannel?: boolean;
```
Source-compatible with every existing adapter (both optional). Do not change any adapter implementation.

### 3b. `DeferInteractionPolicy` — `packages/core/src/policies/defer.ts`
```ts
import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "../interaction-policy.js";

/**
 * The front owns full-duplex interaction (turn-taking, barge-in, backchannels). This policy takes no
 * action — it observes only, so the coordinator drives nothing and the front's own decisions (surfaced
 * by its adapter/bridge as interrupt.detected / eos.turn_complete) stand. RFC InteractionPolicy REQ-4.
 */
export class DeferInteractionPolicy implements InteractionPolicy {
  observe(_obs: InteractionObservation): readonly InteractionDecision[] {
    return [];
  }
  reset(_contextId: string): void {}
}
```
Export from `packages/core/src/index.ts`.

### 3c. Session selection — `packages/core/src/voice-agent-session.ts`
- Add to `VoiceAgentSessionConfig` (near `endpointingOwner`):
  ```ts
  /** The front model owns full-duplex interaction (turn-taking + barge-in). When true, the session's
   *  InteractionPolicy runs observe-only (DeferInteractionPolicy) — Syrinx does not drive its own
   *  turn/interrupt decisions; the front's native decisions stand. Default: false (Syrinx drives).
   *  A realtime factory sets this from RealtimeAdapter.caps.supportsFullDuplex. */
  fullDuplex?: boolean;
  ```
- Store `private readonly fullDuplex: boolean;` = `config.fullDuplex === true` in the constructor.
- At policy construction (where `new RuleBasedInteractionPolicy({...})` is today): the coordinator's
  `policy` is `RuleBasedInteractionPolicy` normally, `DeferInteractionPolicy` when `this.fullDuplex`.
  **BUT** the coordinator needs a `TurnArbiter` executor. When deferring there is no rule engine — so:
  - Keep constructing the `RuleBasedInteractionPolicy` (it owns the arbiter the executor needs for the
    direct executor calls `commitClientInterrupt`/`emitInterruptDetected` that the session still makes,
    e.g. client interrupt, latency-filler cancel — those must keep working even in defer mode).
  - Give the `InteractionCoordinator` the deferring policy for its `observe→apply` drive path, while the
    executor stays the rule policy's arbiter. Concretely:
    ```ts
    this.interactionPolicy = new RuleBasedInteractionPolicy({ bus, primarySpeakerGate, ttsPlayout, minInterruptionMs });
    const coordinatorPolicy: InteractionPolicy = this.fullDuplex ? new DeferInteractionPolicy() : this.interactionPolicy;
    this.interaction = new InteractionCoordinator({ bus, policy: coordinatorPolicy, executor: this.interactionPolicy.arbiter });
    ```
  This makes the coordinator's `observe()` drive `DeferInteractionPolicy` (returns [] → applies nothing)
  in full-duplex mode, so VAD/STT-driven barge-in decisions are NOT taken — while direct client-interrupt
  execution still works. Note: `observeBargeInAudio` in the coordinator falls through the
  `instanceof RuleBasedInteractionPolicy` check to `executor.observeBargeInAudio` when the policy is
  Defer — that's a pure arbiter query with no decision emission (the arbiter has no pending barge-in in
  defer mode because `observe` was never fed speech_started), so it stays inert. Acceptable.

## 4. Acceptance criteria — tests

**Pass-to-pass (unchanged, green):** all of `packages/core` (248 currently) + `packages/realtime` (51).
`pnpm --filter @kuralle-syrinx/core test`, `pnpm --filter @kuralle-syrinx/realtime test`,
and `pnpm --filter @kuralle-syrinx/core typecheck` + `pnpm --filter @kuralle-syrinx/realtime typecheck`
all exit 0.

**Fail-to-pass (new):**
- `packages/core/src/policies/defer.test.ts`: `observe` returns `[]` for every observation kind; `reset`
  is a no-op; the class implements `InteractionPolicy`.
- Add ONE test to `packages/core/src/voice-agent-session.test.ts` (additive `it`, do not edit existing):
  `"fullDuplex:true runs the interaction policy observe-only (no VAD-driven interrupt)"` — construct
  `new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280, fullDuplex: true })`, arm assistant
  speaking (a `tts.audio` for `assistant-turn`), then push `vad.speech_started` + a sustained
  `vad.speech_activity` past 280ms (the exact sequence the characterization "commits sustained speech"
  test uses). Assert **no `interrupt.tts`** fires (`interrupts` stays `[]`) — proving defer/observe-only.
  Contrast: the same sequence WITHOUT `fullDuplex` DOES interrupt (already covered by characterization).

## 5. What NOT to do
- Do NOT change any existing adapter, the RealtimeBridge, or any factory (cf-agents/withVoice) — the
  factory auto-wiring of `fullDuplex` from `caps.supportsFullDuplex` is a separate follow-up.
- Do NOT edit existing tests. Do NOT touch the RuleBased/coordinator/arbiter internals beyond the
  construction conditional in the session.
- No `--no-verify`, `@ts-ignore`, `as any`, silent catch.

## 6. Proof
Save `pnpm --filter @kuralle-syrinx/core test` + `... realtime test` output to
`sprints/interaction-policy/artifacts/ip-c2.txt`. `.handoff/proof-ip-c2.json`: `commands_run` (each
`{command, exit_code}` — core+realtime typecheck+test, exit 0), `claims[]` (each with a `type` field),
`satisfies_assertions` = `["REQ-4","test:defer-observe-only","test:session-fullduplex-observe-only"]`,
`files_changed`, `demo_artifact`. Commit `[IP-C2] ...`. Exit — no PR.

## 7. If stuck
If the observe-only wiring can't be made to keep the direct executor calls
(`commitClientInterrupt`/`emitInterruptDetected`) working while suppressing VAD-driven decisions, STOP →
`.handoff/blocked-ip-c2.md` with the exact conflict.
