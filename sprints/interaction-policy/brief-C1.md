# Story Brief — `IP-C1` InteractionPolicy seam + coordinator + RuleBasedInteractionPolicy (barge-in)

> **You are the IC engineer (`grok` worker — fresh process, clean context).** Self-contained. If
> anything here contradicts what's on disk, **STOP** and write `.handoff/blocked-ip-c1.md` with the exact
> conflict — do not improvise around it.
>
> **Branch:** `plan/interaction-policy` (already checked out; off `beta`). **Commit:** one atomic
> `[IP-C1] InteractionPolicy seam + coordinator + RuleBasedInteractionPolicy (barge-in)`. No push, no main.
> **Proof:** `.handoff/proof-ip-c1.json`.
> **You develop + typecheck + unit-test only. Do NOT run any live smoke** (the manager runs those).

---

## 1. Goal

Introduce a model-agnostic **interaction-control seam** in `packages/core` and route the **barge-in**
(interrupt) decision through it, **behavior-preserving**. Today the barge-in decision lives in
`TurnArbiter`, driven by the session's VAD/STT handlers, emitting `interrupt.detected` to the bus. After
this chunk, a swappable `InteractionPolicy` produces the interrupt **decision** and an
`InteractionCoordinator` **executes** it — with the `RuleBasedInteractionPolicy` implementing the decision
via the existing `TurnArbiter` engine. Net runtime behavior is identical; a future VAP policy will produce
the same decision through the same executor.

**This chunk is barge-in ONLY.** Do NOT touch the `endpointingOwner` (provider_stt|smart_turn|timer)
EOS/take-turn path — that is a separate later chunk. Leave every `endpointingOwner` branch exactly as-is.

## 2. Required reading (read before touching anything)
1. `docs/rfc-interaction-policy-seam.md` §4.1 (the seam types), §5.1 (TurnArbiter becomes the executor),
   §7 (blueprint). NOTE: this brief **refines** §4.1 — the observation union is extended with VAD-boundary
   kinds (see §3). Where this brief and the RFC differ, **this brief wins**.
2. `packages/core/src/turn-arbiter.ts` — the whole file. This is the RuleBased decision engine. Note the
   two terminal interrupt emissions you will route through a sink: in `tryCommit` (the
   `this.emitInterruptDetected(...)` at the end) and in `onSpeechStarted` (the `minInterruptionMs <= 0`
   immediate path that calls `this.emitInterruptDetected(...)`). Note the **public executor** methods
   `emitInterruptDetected` and `commitClientInterrupt` (these stay bus-emitting — they are called
   directly by the session).
3. `packages/core/src/turn-arbiter.test.ts` and `turn-arbiter.characterization.test.ts` — the guards.
   **Both must stay green UNCHANGED.** `turn-arbiter.test.ts` constructs a bare `TurnArbiter` with no
   sink → it must keep pushing `interrupt.detected` to the bus (default behavior unchanged).
   `characterization.test.ts` drives the real `VoiceAgentSession` → net bus output must be identical.
4. `packages/core/src/voice-agent-session.ts` — the arbiter wiring. The call sites you will relocate to
   go through the coordinator (line numbers approximate; find them):
   - `handleSttInterim` → `noteInterimEvidence(pkt.text)` (~651)
   - `handleSttResult` → `noteInterimEvidence(pkt.text, pkt.confidence)` (~669)
   - `maybeBargeInFromProviderStt` → `onProviderSttEvidence(...)` (~715)
   - `handleVadAudioForSpeakerGate` → `observeBargeInAudio(pkt)` (~691)
   - `handleVadSpeechStarted` → `onSpeechStarted(pkt, interruptedContextId)` (~745)
   - `handleVadSpeechActivity` → `onSpeechActivity(pkt)` (~749)
   - `handleVadSpeechEnded` → `onSpeechEnded(pkt, Boolean(this.latestActiveTtsContextId()))` (~768)
   - `cancelLatencyFillerTurn` → `emitInterruptDetected(contextId)` (~996) — **executor, stays direct**
   - `requestClientInterrupt` → `commitClientInterrupt(contextId)` (~483) — **executor, stays direct**
   - `closeOnce` → `clear()` (~449) and the `turn.change` handler `clear()` (~551)
   - construction `new TurnArbiter({...})` (~347)
5. `packages/core/src/pipeline-bus.ts` (`Route`, `push`, `on`), `packets.ts`
   (`VadSpeechStartedPacket`, `VadSpeechActivityPacket`, `VadSpeechEndedPacket`, `VadAudioPacket`,
   `SttInterimPacket`, `SttResultPacket`, `InterruptionDetectedPacket`), `index.ts` (exports).

## 3. Interfaces to create — `packages/core/src/interaction-policy.ts`

```ts
export interface WordTiming { readonly word: string; readonly startMs: number; readonly endMs: number; readonly confidence: number; }

// Observation union. RFC §4.1 kinds (audio_frame/stt_partial/stt_final/playout_tick/delegate_state) are
// kept for the future VAP/Defer policies; this chunk ADDS the vad_* boundary kinds the RuleBased engine
// needs (additive — a VAP policy ignores them). Every field readonly.
export type InteractionObservation =
  | { readonly kind: "vad_speech_started"; readonly contextId: string; readonly timestampMs: number; readonly confidence: number; readonly interruptedContextId: string }
  | { readonly kind: "vad_speech_activity"; readonly contextId: string; readonly timestampMs: number }
  | { readonly kind: "vad_speech_ended"; readonly contextId: string; readonly timestampMs: number; readonly hasActiveTts: boolean }
  | { readonly kind: "vad_barge_in_audio"; readonly contextId: string; readonly timestampMs: number; readonly audio: Uint8Array }
  | { readonly kind: "stt_partial"; readonly contextId: string; readonly timestampMs: number; readonly text: string; readonly confidence?: number; readonly interruptedContextId?: string; readonly wordTimings?: readonly WordTiming[] }
  | { readonly kind: "stt_final"; readonly contextId: string; readonly timestampMs: number; readonly text: string; readonly confidence?: number; readonly interruptedContextId?: string }
  | { readonly kind: "audio_frame"; readonly contextId: string; readonly timestampMs: number; readonly audio?: Int16Array; readonly wordTimings?: readonly WordTiming[]; readonly prosody?: Float32Array }
  | { readonly kind: "playout_tick"; readonly contextId: string; readonly timestampMs: number; readonly playedOutMs?: number; readonly ttsActive?: boolean }
  | { readonly kind: "delegate_state"; readonly contextId: string; readonly timestampMs: number; readonly delegateInFlight?: boolean };

export type InteractionDecision =
  | { readonly kind: "keep_listening" }
  | { readonly kind: "take_turn"; readonly confidence: number }
  | { readonly kind: "backchannel"; readonly cue: string }
  | { readonly kind: "hold" }
  | { readonly kind: "interrupt"; readonly interruptedContextId: string };

export interface InteractionPolicy {
  /** Frame/event-incremental decider. MUST be synchronous and cheap. May return []. */
  observe(obs: InteractionObservation): readonly InteractionDecision[];
  /** Reset per-epoch state on turn/epoch boundary. */
  reset(contextId: string): void;
}
```

## 4. `TurnArbiter` change — add an optional interrupt sink (ONLY change to this file)

Add to `TurnArbiterDeps`: `readonly onInterrupt?: (interruptedContextId: string, source: "vad") => void;`

Introduce a private `private decideInterrupt(interruptedContextId: string): void` that does:
```ts
if (this.deps.onInterrupt) { this.deps.onInterrupt(interruptedContextId, "vad"); return; }
this.emitInterruptDetected(interruptedContextId);
```
Replace the **two autonomous-commit** call sites that currently call `this.emitInterruptDetected(...)`
inside the decision logic — the one at the end of `tryCommit` and the `minInterruptionMs <= 0` immediate
path in `onSpeechStarted` — with `this.decideInterrupt(...)`. **Do NOT change** the public
`emitInterruptDetected` or `commitClientInterrupt` bodies (they stay bus-emitting — they are the executor).
With `onInterrupt` absent, behavior is byte-identical → `turn-arbiter.test.ts` unchanged.

## 5. `RuleBasedInteractionPolicy` — `packages/core/src/policies/rule-based.ts`

```ts
export interface RuleBasedInteractionPolicyDeps {
  readonly bus: PipelineBus;
  readonly primarySpeakerGate: PrimarySpeakerGate;
  readonly ttsPlayout: TtsPlayoutClock;
  readonly minInterruptionMs: number;
}
export class RuleBasedInteractionPolicy implements InteractionPolicy {
  readonly arbiter: TurnArbiter;   // exposed so the coordinator can call executor methods
  private pending: InteractionDecision[] = [];
  constructor(deps: RuleBasedInteractionPolicyDeps) {
    this.arbiter = new TurnArbiter({ ...deps, onInterrupt: (id) => this.pending.push({ kind: "interrupt", interruptedContextId: id }) });
  }
  observe(obs: InteractionObservation): readonly InteractionDecision[] {
    switch (obs.kind) {
      case "vad_speech_started": this.arbiter.onSpeechStarted({ kind: "vad.speech_started", contextId: obs.contextId, timestampMs: obs.timestampMs, confidence: obs.confidence }, obs.interruptedContextId); break;
      case "vad_speech_activity": this.arbiter.onSpeechActivity({ kind: "vad.speech_activity", contextId: obs.contextId, timestampMs: obs.timestampMs, isAsync: true }); break;
      case "vad_speech_ended": this.arbiter.onSpeechEnded({ kind: "vad.speech_ended", contextId: obs.contextId, timestampMs: obs.timestampMs }, obs.hasActiveTts); break;
      case "vad_barge_in_audio": this.arbiter.observeBargeInAudio({ kind: "vad.audio", contextId: obs.contextId, timestampMs: obs.timestampMs, audio: obs.audio }); break;
      case "stt_partial": this.arbiter.noteInterimEvidence(obs.text, obs.confidence); if (obs.interruptedContextId) this.arbiter.onProviderSttEvidence(obs.contextId, obs.timestampMs, obs.interruptedContextId); break;
      case "stt_final": this.arbiter.noteInterimEvidence(obs.text, obs.confidence); if (obs.interruptedContextId) this.arbiter.onProviderSttEvidence(obs.contextId, obs.timestampMs, obs.interruptedContextId); break;
      default: break; // audio_frame/playout_tick/delegate_state — no-op for RuleBased in C1
    }
    if (this.pending.length === 0) return [];
    const out = this.pending; this.pending = []; return out;
  }
  reset(_contextId: string): void { this.arbiter.clear(); }
}
```
Note: reconstruct the arbiter's input packets exactly (same fields the session passed today). `stt_partial`
carried `noteInterimEvidence(text)` with no confidence today (interim) vs `stt_final` with confidence —
preserve that: for `stt_partial` call `noteInterimEvidence(obs.text)` (no confidence) to match
`handleSttInterim`; for `stt_final` call `noteInterimEvidence(obs.text, obs.confidence)`.

## 6. `InteractionCoordinator` — `packages/core/src/interaction-coordinator.ts`

```ts
export class InteractionCoordinator {
  constructor(private readonly deps: { bus: PipelineBus; policy: InteractionPolicy; executor: TurnArbiter }) {}
  observe(obs: InteractionObservation): void {
    for (const d of this.deps.policy.observe(obs)) this.apply(d);
  }
  private apply(d: InteractionDecision): void {
    switch (d.kind) {
      case "interrupt": this.deps.executor.emitInterruptDetected(d.interruptedContextId); break;
      // take_turn / backchannel / hold / keep_listening → later chunks; no-op in C1
      default: break;
    }
  }
  reset(contextId: string): void { this.deps.policy.reset(contextId); }
}
```
`executor` is the SAME `TurnArbiter` instance the `RuleBasedInteractionPolicy` holds
(`policy.arbiter`) — so `apply(interrupt)` calls `emitInterruptDetected` → `bus.push(interrupt.detected)`
exactly as today.

## 7. `VoiceAgentSession` wiring (surgical — only the arbiter calls move)

- Construct `this.interactionPolicy = new RuleBasedInteractionPolicy({ bus, primarySpeakerGate, ttsPlayout, minInterruptionMs })`
  and `this.interaction = new InteractionCoordinator({ bus, policy: this.interactionPolicy, executor: this.interactionPolicy.arbiter })`
  where `new TurnArbiter(...)` is today (~347). Remove the standalone `this.turnArbiter = new TurnArbiter(...)`;
  the arbiter now lives inside the policy. Add a private getter `private get turnArbiter() { return this.interactionPolicy.arbiter; }`
  so the **executor**-style direct calls (`commitClientInterrupt` at ~483, `emitInterruptDetected` at ~996,
  `clear` at ~449/~551) keep working unchanged.
- Replace the **decision-driving** arbiter calls with coordinator observations (keep every surrounding
  guard, event emit, debugPush, watchdog, enrollment line EXACTLY as-is — only the one arbiter call per
  handler changes):
  - `handleSttInterim`: `this.turnArbiter.noteInterimEvidence(pkt.text)` → build a `stt_partial` obs. But
    note today interim ALSO drives `maybeBargeInFromProviderStt`. Keep `maybeBargeInFromProviderStt` as the
    place that decides the provider-STT interruptedContextId; have it call
    `this.interaction.observe({ kind: "stt_partial"/"stt_final", ..., interruptedContextId })`. Simplest:
    in `handleSttInterim` call `this.interaction.observe({ kind:"stt_partial", contextId:pkt.contextId, timestampMs:pkt.timestampMs, text:pkt.text, interruptedContextId: <as maybeBargeIn computes> })`.
    Look at `maybeBargeInFromProviderStt` — it early-returns unless `endpointingOwner==="provider_stt"` &&
    text.trim() && there's an active TTS context. Preserve that gating: compute `interruptedContextId` only
    under those conditions, else omit it. **The `noteInterimEvidence` (evidence recording) must happen
    regardless** (it does today, before the barge-in gate). So: always emit the `stt_partial`/`stt_final`
    obs for evidence; include `interruptedContextId` only when the provider-STT barge-in gate passes.
  - `handleVadAudioForSpeakerGate`: the `if (this.turnArbiter.observeBargeInAudio(pkt)) return;` early-return
    is behavior-critical (it returns true when a barge-in is pending, skipping enrollment). Preserve it:
    have the coordinator's `observe` for `vad_barge_in_audio` return whether it was consumed. Simplest: keep
    a thin method on the coordinator `observeBargeInAudio(pkt): boolean` that forwards to
    `this.executor.observeBargeInAudio(pkt)` — this is a pure arbiter query, acceptable to expose. Then
    `if (this.interaction.observeBargeInAudio(pkt)) return;`.
  - `handleVadSpeechStarted`: after its guards, `this.turnArbiter.onSpeechStarted(pkt, interruptedContextId)`
    → `this.interaction.observe({ kind:"vad_speech_started", contextId:pkt.contextId, timestampMs:pkt.timestampMs, confidence:pkt.confidence, interruptedContextId })`.
  - `handleVadSpeechActivity`: → `this.interaction.observe({ kind:"vad_speech_activity", contextId:pkt.contextId, timestampMs:pkt.timestampMs })`.
  - `handleVadSpeechEnded`: → `this.interaction.observe({ kind:"vad_speech_ended", contextId:pkt.contextId, timestampMs:pkt.timestampMs, hasActiveTts: Boolean(this.latestActiveTtsContextId()) })`.
- Keep `clear()` calls as `this.turnArbiter.clear()` (via the getter) OR `this.interaction.reset("")` — use
  `this.turnArbiter.clear()` to stay identical (reset also clears, but clear is the current call).

**Guard against double-drive:** ensure the session no longer calls the arbiter's decision methods anywhere
except through the coordinator; grep the final `voice-agent-session.ts` for `this.turnArbiter.` — only
`clear`, `commitClientInterrupt`, `emitInterruptDetected` (executor) may remain.

## 8. Exports — `packages/core/src/index.ts`
Export `InteractionPolicy`, `InteractionObservation`, `InteractionDecision`, `WordTiming`,
`RuleBasedInteractionPolicy`, `InteractionCoordinator`.

## 9. Acceptance criteria — tests

**Pass-to-pass (MUST stay green UNCHANGED — do not edit these files):**
- `packages/core/src/turn-arbiter.test.ts` (bare arbiter, no sink → bus-pushes unchanged).
- `packages/core/src/turn-arbiter.characterization.test.ts` (real session; net bus output identical).
- `pnpm --filter @kuralle-syrinx/core typecheck` exit 0; `pnpm --filter @kuralle-syrinx/core test` exit 0
  (baseline was 241 tests / 23 files — must be ≥ that, all green).

**Fail-to-pass (new tests you write):**
- `packages/core/src/interaction-coordinator.test.ts`:
  - an `interrupt` decision from a stub policy → coordinator calls `executor.emitInterruptDetected` →
    `interrupt.detected` pushed once (assert via `bus.on`).
  - `take_turn`/`backchannel`/`hold`/`keep_listening` → no bus effect in C1 (no-op).
- `packages/core/src/policies/rule-based.test.ts`:
  - **parity vector:** feed the same sequence the characterization "commits sustained speech" case uses
    (`vad_speech_started` with active-tts interruptedContextId, then `vad_speech_activity` past
    `minInterruptionMs`) → `observe` returns exactly one `{kind:"interrupt", interruptedContextId}` at the
    commit frame and `[]` before it.
  - short-blip suppression (`vad_speech_ended` before minInterruptionMs) → no interrupt decision emitted;
    the arbiter's suppression metric still pushed.
  - backchannel interim suppression → no interrupt decision.
  - `reset` clears pending state.

## 10. What NOT to do
- Do NOT touch the `endpointingOwner` EOS/take-turn path, the finalizer gating (`~1404-1430`), or the
  `eosAudio` fan-out branch (`~614-628`). Barge-in only.
- Do NOT edit `turn-arbiter.test.ts` or `turn-arbiter.characterization.test.ts`. If you think you must,
  STOP → `.handoff/blocked-ip-c1.md` (that means behavior moved — a real defect).
- Do NOT change the public `emitInterruptDetected` / `commitClientInterrupt` bodies.
- Do NOT add a VAP model, ONNX, or the observe-driven bus-subscribing coordinator — the session drives the
  coordinator by calling `observe(...)`; there is no `bus.on` inside the coordinator in C1.
- No `--no-verify`, `@ts-ignore`, `as any`, silent catch, raw `setTimeout`.

## 11. Demo + proof
- Save `pnpm --filter @kuralle-syrinx/core test` output to `sprints/interaction-policy/artifacts/ip-c1.txt`.
- `.handoff/proof-ip-c1.json`: `commands_run` (each `{cmd, exit}` — core typecheck + test, exit 0),
  `satisfies_assertions` = `["REQ-1","REQ-2","REQ-3","REQ-8","test:coordinator-maps-decisions","test:rule-based-parity"]`,
  `files_changed`, `demo_artifact`, `notes` (anything you were unsure about). **Every `claims[]` entry needs
  a `type` field.** Commit `[IP-C1] ...`. Exit — no PR, no push.

## 12. If stuck
If you cannot keep `turn-arbiter.characterization.test.ts` green while routing barge-in through the
coordinator, STOP and write `.handoff/blocked-ip-c1.md` with the exact failing case and what you tried.
Do NOT edit the characterization test to make it pass — a red characterization test means behavior moved,
which is the one thing this chunk must not do.
