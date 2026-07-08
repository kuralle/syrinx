# RFC: InteractionPolicy — a model-agnostic full-duplex interaction-control seam

**Category:** Architectural Change
**Author:** octalpixel
**Date:** 2026-07-09
**Status:** Draft
**Reviewers:** (maintainer)
**Related:**
- `.understanding/syrinx-voice-engine-understand.md` (code map + invariants; contextId overload)
- `research/full-duplex-orchestration-litreview.md` (verified prior art, 22 sources)
- `docs/rfc-bimodel-delegate-seam.md` (Responder-Thinker; the delegation half, already shipped v4.0.0)
- `docs/rfc-reasoner-latency.md` (speculative/latency work, adjacent)
- `SESSION-HANDOFF-syrinx-core-roadmap.md` (unifies plan-of-record items #2 half-cascade + #3 eval harness)
- Memory: `gpt-live-validates-orchestration-thesis`, `latency-is-top-priority`

---

## 1. Problem Statement

Syrinx's interaction control — the decision of *when to speak, keep listening, backchannel, or interrupt* —
is smeared across three turn-shaped components:

- the **endpointing owner** (`endpointingOwner: "provider_stt" | "smart_turn" | "timer"`,
  `packages/core/src/voice-agent-session.ts:164`) decides end-of-turn;
- **`TurnArbiter`** (`packages/core/src/turn-arbiter.ts:69`) decides barge-in commit at a fixed
  `minInterruptionMs` (280 ms default);
- **EOS detection** fires the turn boundary (`eos.turn_complete`).

There is **no continuous "should I speak now?" policy** and **no backchannel** capability. This is exactly the
limitation OpenAI's GPT-Live (2026-07) calls "turn-based": turn detection is silence/endpoint-based, so a
pause reads as end-of-turn and the agent interrupts unnaturally. GPT-Live closes it with **full-duplex
continuous interaction** — a model deciding many times per second — but *bundles* interaction and generation
into one closed model welded to one reasoner.

Syrinx already shipped the *other* GPT-Live change (delegation → the Responder-Thinker seam, v4.0.0). The
wedge here is to expose the full-duplex change as an **open, model-agnostic orchestration**: make the
interaction policy its own small, swappable, learned component that drives *any* generation backend (cascade,
turn-based realtime, half-cascade, or a native full-duplex conductor).

**Success criteria (concrete):**
- A single `InteractionPolicy` seam exists in `packages/core`; the three current owners are reimplemented as
  policies behind it with **zero behavior change** (characterization tests green).
- A `VapInteractionPolicy` (Voice Activity Projection–class learned controller) is selectable behind the same
  seam and drives both the cascade and realtime paths.
- Backchannels ("mhmm") are emitted during the delegate thinking-gap on both paths.
- The policy loop adds **~0** to the ~800–1000 ms voice-to-voice budget (measured, latency gate REQ-9).
- An **eval harness** measures turn-taking quality × agentic task success across architecture configs; the
  thesis is declared proven only when `cascade+VAP+rich-seam` matches `native-realtime` on turn-taking
  metrics without regressing task success.

## 2. Background

**Current topology** (`.understanding/syrinx-voice-engine-understand.md`): transport → `user.audio_received`
→ (VAD / STT / EOS) → `eos.turn_complete` → `ReasoningBridge(Reasoner)` → `llm.delta` → sentence-buffer →
`tts.text` → TTS → `tts.audio`. A parallel realtime path swaps the STT+LLM+TTS core for `RealtimeBridge`
(`packages/realtime/src/realtime-bridge.ts`) with a native front + async reasoner back. Both topologies flow
over the shared 3-priority `PipelineBus` (`packages/core/src/pipeline-bus.ts:23`, `Route{Critical,Main,Background}`),
and `TurnArbiter` + `VoiceAgentSession` are **core-level and shared** — which is what makes a single
core-level policy seam able to serve both paths.

**Why the current shape falls short.** The three owners are independently reasonable but do not compose into a
continuous policy: `provider_stt` defers timing to Deepgram endpointing; `smart_turn` runs Silero VAD +
Pipecat SmartTurn ONNX + a semantic-completeness regex (`packages/pipecat-smart-turn/src/semantic-completeness.ts`,
Node only); `timer` is a fixed grace. None emits backchannels, none decides "keep listening because the user
is mid-thought" from the *joint* audio+semantic stream. The v4.1.0 Flux semantic-EOT adapter and speculative
generation push toward duplex behavior but remain separate, turn-shaped mechanisms.

**Prior art (verified — `research/full-duplex-orchestration-litreview.md`).** Turn-taking is a *separable,
small, real-time, learned, portable* model: Voice Activity Projection (Ekstedt & Skantze, Interspeech 2022) is
self-supervised and frame-incremental; it is multilingual (arXiv:2403.06487), fine-tunable for backchannel
timing (arXiv:2410.15929) and end-of-turn, improves with a richer-than-VAD seam (prompt-guided VAP, SIGDIAL
2025; multimodal VAP, arXiv:2506.03980), and has been reused as a *general* controller on systems it was not
built for (arXiv:2501.08946). A dedicated controller driving a full-duplex generator already exists as a
research prototype (semantic-VAD-as-dialogue-manager, arXiv:2502.14145). The field has **not** converged —
a native single-model camp is active (BayLing-Duplex arXiv:2606.14528; FLM-Audio arXiv:2509.02521) — so this
RFC commits to the decoupled bet with eyes open (see §12/Alternatives).

**Interface-shape note.** Two shapes were considered for the seam (see §4): (a) a synchronous frame-incremental
`observe() -> Decision[]` decider, and (b) an async decision stream. Shape (b) lost: VAP runs per ~20 ms frame
and the bus is event-driven; an async stream adds scheduling latency against the §9 latency gate for no
expressive gain. Shape (a) is specified below.

## 3. Strict Requirements

- **REQ-1 (single seam):** All interaction decisions {keep-listening, take-turn, backchannel, hold, interrupt}
  are produced by one `InteractionPolicy` implementation per session, in `packages/core`.
- **REQ-2 (reshape, not patch):** The current `provider_stt` / `smart_turn` / `timer` behaviors are
  reimplemented *as* `InteractionPolicy` implementations. No fourth parallel owner is added; the
  `endpointingOwner` union is superseded, not extended. Behavior is preserved (REQ-8).
- **REQ-3 (serves both topologies):** The same seam drives cascade (`VoiceAgentSession` EOS path) and realtime
  (`RealtimeBridge`). Cascade and realtime differ only in which observations are available, not in the seam.
- **REQ-4 (capability negotiation):** When `RealtimeAdapter.caps.supportsFullDuplex` is true, Syrinx **defers**
  to the front's duplex decisions (policy runs observe-only). Otherwise Syrinx's policy **drives**. When
  `caps.emitsBackchannel` is true, Syrinx suppresses its own backchannels.
- **REQ-5 (learned controller):** A `VapInteractionPolicy` is selectable, loading an ONNX VAP checkpoint via
  the same runtime pattern as `packages/silero-vad` and `packages/pipecat-smart-turn`.
- **REQ-6 (backchannels):** The policy can emit a short backchannel cue during the delegate thinking-gap,
  rendered through the existing `BackgroundAudioMixer` (`packages/server-websocket`) and gated by REQ-4.
- **REQ-7 (rich-typed seam, additive):** Observations *may* carry word-level timings and a prosody embedding;
  `VapInteractionPolicy` consumes them when present and degrades gracefully when absent. No existing packet
  loses a field.
- **REQ-8 (behavior preservation):** With `RuleBasedInteractionPolicy` selected, existing turn-taking and
  barge-in characterization tests (`turn-arbiter.characterization.test.ts`) pass unchanged.
- **REQ-9 (latency gate):** `InteractionPolicy.observe` p99 ≤ 5 ms per frame on the edge; end-to-end
  `turn_latency` (TTFA decomposition) shows **no regression** vs the `RuleBasedInteractionPolicy` baseline in
  the A/B smoke before `VapInteractionPolicy` is recommended.
- **REQ-10 (dual runtime):** Works on both the Node host and the Cloudflare Workers edge
  (`withVoice(Agent)`); ONNX inference must run in the Workers runtime or degrade to a defer/rule policy there.
- **REQ-11 (eval gate):** An eval harness produces per-config numbers on Full-Duplex-Bench-style turn-taking
  metrics and a voice-τ-bench task-success metric before the decoupled thesis is claimed proven.

## 4. Interface Specification

### 4.1 InteractionPolicy (the seam)

- **Location:** `packages/core/src/interaction-policy.ts`
- **Signatures:**
  ```ts
  export interface WordTiming { readonly word: string; readonly startMs: number; readonly endMs: number; readonly confidence: number; }

  export interface InteractionObservation {
    readonly kind: "audio_frame" | "stt_partial" | "stt_final" | "playout_tick" | "delegate_state";
    readonly contextId: string;          // turn-epoch id (see §5.3 dependency)
    readonly timestampMs: number;
    readonly audio?: Int16Array;          // 20 ms frame at ENGINE_SAMPLE_RATE_HZ (audio_frame)
    readonly text?: string;               // partial/final transcript
    readonly wordTimings?: readonly WordTiming[];  // rich seam (REQ-7), optional
    readonly prosody?: Float32Array;      // rich seam: prosody/emotion embedding, optional
    readonly playedOutMs?: number;        // TtsPlayoutClock position (playout_tick)
    readonly ttsActive?: boolean;
    readonly delegateInFlight?: boolean;  // Responder-Thinker thinking-gap open
  }

  export type InteractionDecision =
    | { readonly kind: "keep_listening" }
    | { readonly kind: "take_turn"; readonly confidence: number }            // commit end-of-turn
    | { readonly kind: "backchannel"; readonly cue: string }                 // e.g. "mhmm"
    | { readonly kind: "hold" }                                              // user still has the floor
    | { readonly kind: "interrupt"; readonly interruptedContextId: string }; // barge-in commit

  export interface InteractionPolicy {
    /** Frame-incremental decider. MUST be synchronous and cheap (REQ-9). May return []. */
    observe(obs: InteractionObservation): readonly InteractionDecision[];
    /** Reset per-epoch state on turn/epoch boundary. */
    reset(contextId: string): void;
  }
  ```
- **Behavior:** pure function of the observation stream + internal state; emits zero or more decisions per
  observation. Never performs I/O on the hot path; never blocks.
- **Error cases:** an implementation that throws in `observe` is caught by the coordinator, logged as a
  recoverable `llm.error` (`component: "interaction_policy"`), and the coordinator falls back to
  `keep_listening` for that frame (fail-open to "don't cut the user off").

### 4.2 Policy implementations

- **`RuleBasedInteractionPolicy`** — `packages/core/src/policies/rule-based.ts`. Wraps the current
  `provider_stt` / `smart_turn` / `timer` logic behind the seam (REQ-2, REQ-8). Constructed from the same
  config the owners consume today.
- **`DeferInteractionPolicy`** — `packages/core/src/policies/defer.ts`. Emits only what the *front* signals
  (maps adapter `speech_started` / `response_*` events to decisions). Selected automatically when
  `caps.supportsFullDuplex` (REQ-4).
- **`VapInteractionPolicy`** — `packages/vap/src/index.ts` (new package, mirrors `silero-vad`/`pipecat-smart-turn`
  packaging). ONNX VAP checkpoint; frame-incremental; consumes `audio` (+ `wordTimings`/`prosody` when present).
  Emits `take_turn` / `backchannel` / `hold` / `keep_listening`.

### 4.3 InteractionCoordinator (wiring)

- **Location:** `packages/core/src/interaction-coordinator.ts`
- **Signature:** `class InteractionCoordinator { constructor(deps: { bus: PipelineBus; policy: InteractionPolicy; arbiter: TurnArbiter; caps: FrontCaps }); }`
- **Behavior:** subscribes to bus signals (`user.audio_received`, `stt.partial`, `stt.result`,
  `tts.playout_progress`, delegate lifecycle), builds `InteractionObservation`s, calls `policy.observe`, and
  maps each decision to an existing bus effect (§6). Owns no policy logic itself.

### 4.4 caps additions

- **Location:** `packages/realtime/src/realtime-adapter.ts` (`caps` object, currently
  `inputSampleRateHz | outputSampleRateHz | supportsConcurrentToolAudio | supportsTruncate | emitsServerSpeechStarted | supportsNativeResume?`).
- **Add:** `readonly supportsFullDuplex?: boolean;` and `readonly emitsBackchannel?: boolean;` (both optional;
  absent = false = Syrinx drives). Source-compatible with every existing adapter.

### 4.5 New packets

- **Location:** `packages/core/src/packets.ts`
- `InteractionBackchannelPacket` (`kind: "interaction.backchannel"`, Route.Main): `{ contextId, timestampMs, cue }`.
- `SttPartialPacket` (`kind: "stt.partial"`, Route.Main): `{ contextId, timestampMs, text, wordTimings? }` —
  the rich-seam carrier (REQ-7); optional, emitted by STT adapters that can (Deepgram/Flux).

## 5. Architecture and System Dependencies

### 5.1 Structural changes

```
BEFORE                                  AFTER
------                                  -----
endpointingOwner: provider_stt          InteractionPolicy (seam, packages/core)
                | smart_turn      ==>      ├─ RuleBasedInteractionPolicy  (= old 3 owners, behavior-preserved)
                | timer                    ├─ DeferInteractionPolicy      (caps.supportsFullDuplex)
TurnArbiter (barge-in, standalone)         └─ VapInteractionPolicy        (learned, new @kuralle-syrinx/vap)
EOS finalizers (per-plugin)             InteractionCoordinator drives the seam; TurnArbiter becomes the
                                        interrupt *executor* the policy calls, not an independent decider.
```

- **Created:** `interaction-policy.ts`, `interaction-coordinator.ts`, `policies/{rule-based,defer}.ts`, new
  package `@kuralle-syrinx/vap`, `InteractionBackchannelPacket` + `SttPartialPacket`.
- **Superseded:** the `endpointingOwner` union collapses to a policy selection. `TurnArbiter` is retained but
  is invoked by the coordinator (its `emitInterruptDetected` / `commitClientInterrupt` become the executor for
  a policy `interrupt` decision) rather than deciding independently.
- **Deleted:** nothing in the first cut; the reshape preserves behavior, then the old owner-selection code path
  is removed once `RuleBasedInteractionPolicy` is proven at parity (zero-tech-debt — no dual shape kept).

### 5.2 Service and library dependencies
- ONNX runtime for `VapInteractionPolicy` (same dependency posture as `silero-vad`/`pipecat-smart-turn`).
  Workers-runtime ONNX support is a REQ-10 risk (§11).
- No new external network services. VAP inference is local.

### 5.3 Data and schema changes
- **Dependency (blocking for full-duplex mode): `contextId → turn-epoch` reshape.** Full-duplex has no clean
  turn boundary, so the `contextId = turn id` overload (`.understanding/syrinx-voice-engine-understand.md`
  Open Q1; telephony P0 cluster) breaks harder. `InteractionObservation.contextId` and
  `reset(contextId)` assume a `contextId + generation-epoch`. **Partial delivery is possible without it:**
  C1–C3 (seam + defer + backchannels, turn-scoped) do not need the reshape; the VAP full-duplex mode (C5's
  overlap/no-boundary behavior) does. Tracked as a separate reshape RFC.

### 5.4 Network and performance
- The policy runs in-process on the hot path; no added RPC. REQ-9 caps `observe` at p99 ≤ 5 ms/frame.
- Backchannel cues are short pre-cached PCM (see §12 Q2) mixed under the existing outbound paths — no synthesis
  round-trip on the hot path.

## 6. Pseudocode

```
# InteractionCoordinator — one per session
ON bus signal s:
    obs = build_observation(s)                 # audio_frame | stt_partial | stt_final | playout_tick | delegate_state
    IF caps.supportsFullDuplex:
        # DEFER: front owns duplex; run observe-only for telemetry, take no bus action
        policy.observe(obs); RETURN
    FOR decision IN policy.observe(obs):
        SWITCH decision.kind:
            keep_listening: pass                             # suppress premature finalize
            hold:           suppress_endpoint_finalize()     # user still has floor
            take_turn:      emit eos.turn_complete(obs.contextId)   # commit the turn
            backchannel:    IF NOT caps.emitsBackchannel:
                                push Route.Main interaction.backchannel(cue)
            interrupt:      arbiter.emitInterruptDetected(decision.interruptedContextId)  # existing fan-out

# VapInteractionPolicy.observe — frame-incremental
observe(obs):
    IF obs.kind == audio_frame:
        feats = update_rolling_features(obs.audio, obs.wordTimings?, obs.prosody?)   # rich seam optional
        p = vap_forward(feats)                 # p = {p_shift, p_backchannel, p_hold} over horizon
        IF ttsActive AND p.p_shift > SHIFT_TH: RETURN [interrupt(current_tts_context)]
        IF p.p_backchannel > BC_TH AND obs.delegateInFlight: RETURN [backchannel("mhmm")]
        IF p.p_shift > TAKE_TH: RETURN [take_turn(p.p_shift)]
        IF p.p_hold > HOLD_TH: RETURN [hold]
        RETURN [keep_listening]
    RETURN []
```

## 7. Code Blueprint

```ts
// packages/core/src/interaction-coordinator.ts
export class InteractionCoordinator {
  private readonly disposers: Array<() => void> = [];
  constructor(private readonly deps: {
    bus: PipelineBus; policy: InteractionPolicy; arbiter: TurnArbiter; caps: FrontCaps;
  }) {}

  initialize(): void {
    const { bus } = this.deps;
    this.disposers.push(
      bus.on<UserAudioReceivedPacket>("user.audio_received", (p) =>
        this.dispatch({ kind: "audio_frame", contextId: p.contextId, timestampMs: p.timestampMs, audio: toSamples(p.audio) })),
      bus.on<SttPartialPacket>("stt.partial", (p) =>
        this.dispatch({ kind: "stt_partial", contextId: p.contextId, timestampMs: p.timestampMs, text: p.text, wordTimings: p.wordTimings })),
      bus.on<TextToSpeechPlayoutProgressPacket>("tts.playout_progress", (p) =>
        this.dispatch({ kind: "playout_tick", contextId: p.contextId, timestampMs: p.timestampMs, playedOutMs: p.playedOutMs, ttsActive: true })),
      // delegate_state fed from delegate.query/delegate.result (Responder-Thinker thinking-gap)
    );
  }

  private dispatch(obs: InteractionObservation): void {
    let decisions: readonly InteractionDecision[];
    try { decisions = this.deps.policy.observe(obs); }
    catch (e) { this.failOpen(e, obs); return; }               // fail-open → keep_listening
    if (this.deps.caps.supportsFullDuplex) return;              // observe-only when front owns duplex
    for (const d of decisions) this.apply(d, obs);
  }

  private apply(d: InteractionDecision, obs: InteractionObservation): void {
    const { bus, arbiter, caps } = this.deps;
    switch (d.kind) {
      case "take_turn": bus.push(Route.Main, eosTurnComplete(obs.contextId, obs.timestampMs)); break;
      case "interrupt": arbiter.emitInterruptDetected(d.interruptedContextId); break;
      case "backchannel":
        if (!caps.emitsBackchannel) bus.push(Route.Main, backchannelPacket(obs.contextId, obs.timestampMs, d.cue));
        break;
      case "hold": case "keep_listening": break;                // suppress finalize; no-op emit
    }
  }
}
```

```ts
// packages/realtime/src/realtime-adapter.ts  (caps additions — REQ-4)
readonly caps: {
  // ...existing...
  readonly supportsFullDuplex?: boolean;  // front owns duplex decisions → Syrinx DEFERS
  readonly emitsBackchannel?: boolean;    // front emits its own backchannels → suppress ours
};
```

The `VapInteractionPolicy` mirrors `packages/silero-vad/src/workers.ts` for ONNX session lifecycle and
`packages/pipecat-smart-turn/src/index.ts` for the frame-incremental decision surface; it is the only piece
that loads a model, and it sits entirely behind §4.1 so it is swap-in/swap-out.

## 8. Incremental Task Breakdown

Sequenced by uncertainty: the biggest risk is "does one seam cleanly absorb all three current owners with no
behavior change" — attack that first (C1). The learned model (C5) is highest-effort but lowest-architectural-risk
because it lands behind an already-proven seam.

| ID | Chunk | Files | Grounding (REQ/test) | Acceptance criteria |
|----|-------|-------|----------------------|---------------------|
| C1 | Introduce `InteractionPolicy` seam + `InteractionCoordinator`; reimplement the 3 owners as `RuleBasedInteractionPolicy`; route turn-taking + barge-in through the coordinator | `packages/core/src/interaction-policy.ts`, `interaction-coordinator.ts`, `policies/rule-based.ts`, `voice-agent-session.ts`, `turn-arbiter.ts` | REQ-1,2,3,8; `turn-arbiter.characterization.test.ts` | All existing core/turn-arbiter/session tests green **unchanged**; `pnpm -r test` green; no `endpointingOwner` behavior change observable |
| C2 | `caps.supportsFullDuplex` / `emitsBackchannel` + `DeferInteractionPolicy`; RealtimeBridge selects defer when native | `packages/realtime/src/realtime-adapter.ts`, `realtime-bridge.ts`, `policies/defer.ts` | REQ-4,10 | With a `supportsFullDuplex:true` fake adapter, coordinator takes no bus action (observe-only); realtime tests green |
| C3 | Backchannels: `InteractionBackchannelPacket` + `BackgroundAudioMixer` render + `emitsBackchannel` gate; wire on both transports | `packages/core/src/packets.ts`, `packages/server-websocket/src/*`, `packages/cf-agents/src/with-voice.ts` | REQ-6; new mixer test | Backchannel cue rendered under TTS during a simulated delegate gap; suppressed when `emitsBackchannel:true`; listen-smoke produces audible "mhmm" |
| C4 | Rich-typed seam: `SttPartialPacket` w/ `wordTimings`; Deepgram/Flux adapter emits it; optional prosody field plumbed | `packages/core/src/packets.ts`, `packages/deepgram/src/stt.ts` | REQ-7 | `stt.partial` carries word timings from a live Flux transcript; no existing packet loses a field; policies ignore it safely |
| C5 | `@kuralle-syrinx/vap` — `VapInteractionPolicy` (ONNX VAP checkpoint), frame-incremental; selectable behind the seam | `packages/vap/src/*` (new), `packages/silero-vad` pattern | REQ-5,9,10 | `observe` p99 ≤ 5 ms/frame (bench); drives take_turn/backchannel/hold on the cascade path in a live smoke |
| C6 | Eval harness: config runner + Full-Duplex-Bench-style metrics + voice-τ-bench adapter | `packages/test/*` or `scripts/eval/*` | REQ-11 | Produces a metrics table across ≥4 configs (§9.4); reproducible from one command |

- [ ] **C1:** seam + RuleBasedInteractionPolicy — behavior-preserving reshape
- [ ] **C2:** caps + DeferInteractionPolicy
- [ ] **C3:** backchannels
- [ ] **C4:** rich-typed seam
- [ ] **C5:** VapInteractionPolicy (learned)
- [ ] **C6:** eval harness (proof gate)

## 9. Validation and Testing

### 9.0 Validation contract (assertion IDs)

| ID | Source | Assertion |
|----|--------|-----------|
| REQ-2/8 | §3 | `RuleBasedInteractionPolicy` reproduces current behavior; characterization suite unchanged |
| REQ-4 | §3 | `supportsFullDuplex` → coordinator observe-only; `emitsBackchannel` → own backchannels suppressed |
| REQ-6 | §3 | Backchannel rendered during delegate gap, gated by caps |
| REQ-9 | §3 | `observe` p99 ≤ 5 ms/frame; `turn_latency` no-regression vs rule baseline (A/B) |
| REQ-11 | §3 | Eval harness emits per-config turn-taking × task-success table |
| test:coordinator-maps-decisions | §9.1 | each decision kind maps to the correct bus effect |
| test:defer-observe-only | §9.1 | full-duplex caps → zero bus actions |
| cmd:eval-matrix | §9.4 | one-command config sweep produces the metrics table |

### 9.1 Fail-to-pass tests
- `interaction-coordinator.test.ts` — `take_turn`→`eos.turn_complete`; `interrupt`→arbiter fan-out;
  `backchannel`→packet (and suppressed under `emitsBackchannel`); `hold`/`keep_listening`→no finalize.
- `defer-policy.test.ts` — `supportsFullDuplex:true` ⇒ coordinator emits nothing.
- `rule-based-policy.test.ts` — parity vectors vs the three legacy owners.
- `vap-policy.test.ts` — decision thresholds; latency bench asserts p99 ≤ 5 ms/frame.

### 9.2 Regression (pass-to-pass)
- `pnpm -r typecheck && pnpm -r test` (only pre-existing expected failure:
  `examples/02-hello-voice-headless/scripts/run-studio-bargein-e2e.ts` missing `playwright-core`).
- `turn-arbiter.characterization.test.ts` unchanged (REQ-8).

### 9.3 Validation commands
```bash
pnpm -r typecheck && pnpm -r test
# backchannel listen-smoke (renders mixed.wav during a simulated delegate gap):
pnpm --filter @kuralle-syrinx/examples smoke:backchannel-listen
# latency A/B (rule vs VAP) — short fixture per latency-gate memory:
SYRINX_WS_MAX_TURNS=1 pnpm --filter @kuralle-syrinx/examples smoke:interaction-latency-ab
```

### 9.4 Eval plan (REQ-11 — the proof gate)
Config sweep: `cascade+rules` (today) / `cascade+VAP` / `cascade+VAP+rich-seam` / `native-realtime-solo` /
`realtime+delegate` / `half-cascade+delegate`. Metrics:
- **Turn-taking** (Full-Duplex-Bench v1/v2 style — arXiv:2503.04721 / 2510.07838): pause handling,
  backchannel rate/timing, turn-shift accuracy, interruption/takeover rate, response latency.
- **Task success** (voice adaptation of τ-bench / τ²-bench — arXiv:2406.12045 / 2506.07982): multi-turn
  tool-use success under domain rules.
- **Verdict rule:** thesis proven iff `cascade+VAP+rich-seam` matches `native-realtime` on turn-taking
  **without** a task-success regression. `native-realtime` and `realtime+delegate` are the live baselines;
  **do not** use OpenAI's τ³-Voice-Telecom (vendor-internal, unverifiable).

## 10. Security Considerations
No new external attack surface: the policy is in-process, inference is local, no new network calls. VAP model
artifacts are loaded from bundled assets (same trust boundary as the Silero/SmartTurn ONNX already shipped).
Backchannel cues are static bundled PCM — no user-controlled synthesis path. Confirm the Workers asset budget
for the VAP checkpoint (§11).

## 11. Rollback and Abort Criteria
- **Rollback:** policy selection is config; reverting to `RuleBasedInteractionPolicy` restores current behavior
  with no data migration. The seam is behavior-preserving, so C1 can ship and sit dormant.
- **Abort C5 if:** `observe` p99 exceeds the 5 ms/frame budget on the edge after optimization, OR `turn_latency`
  regresses in the A/B — do **not** recommend VAP; ship the seam + rules + backchannels and keep VAP behind a
  flag pending optimization.
- **Abort full-duplex mode if:** the `contextId → turn-epoch` reshape (§5.3) is not landed — full-duplex
  no-boundary behavior is blocked; turn-scoped C1–C4 still ship.
- **Symptom-patch stop:** if backchannels or take_turn "work" only by special-casing one provider rather than
  through the seam, stop and re-derive at the seam (the whole point is model-agnosticism).

## 12. Open Questions

- **Q1 — Does `InteractionPolicy` own turn finalization or advise the endpointing owner?**
  Tradeoff: owning it is a cleaner seam but a larger reshape (touches `voice-agent-session.ts` finalize path)
  vs advising keeps the owners and adds a fourth decider (dual shape).
  **Proposal:** OWN — collapse the three owners into `RuleBasedInteractionPolicy` (REQ-2). Advising would
  violate zero-tech-debt by keeping the old shape alongside the new.

- **Q2 — Backchannel cues: dynamic TTS synthesis or pre-cached PCM set?**
  Tradeoff: dynamic is flexible but adds a synthesis round-trip on the hot path (latency); pre-cached is fixed
  but instant.
  **Proposal:** pre-cached short PCM cue set (a handful of "mhmm"/"got it" per voice), mixed via
  `BackgroundAudioMixer` — same asset posture as the existing background-audio beds. Dynamic is a later option.

- **Q3 — VAP model: train our own or adapt an open checkpoint?**
  Tradeoff: own model fits our audio/latency exactly but is a research project; open checkpoint ships now.
  **Proposal:** start with an open VAP checkpoint exported to ONNX behind the seam; fine-tune on logged
  traffic later (lit-review §Strategy E). The seam makes this swap invisible to the rest of the engine.

- **Q4 — Is `contextId → turn-epoch` a hard prerequisite for this whole RFC?**
  Tradeoff: doing it first de-risks full-duplex but delays every visible win.
  **Proposal:** NOT a blanket prerequisite. Ship C1–C4 turn-scoped (no reshape needed); gate only C5's
  full-duplex no-boundary mode on the reshape. This lets the seam, defer, backchannels, and rich seam land now.

- **Q5 — Rich-seam prosody embedding: which encoder, and in v1?**
  Tradeoff: adding a prosody encoder now improves VAP (multimodal VAP evidence) but adds a model + latency.
  **Proposal:** defer. `VapInteractionPolicy` v1 consumes `audio` + `wordTimings` only; prosody is a later
  increment once v1 clears the latency gate.

## Risks
- **Workers ONNX (REQ-10):** VAP inference may not run acceptably in the Workers runtime; mitigation —
  `DeferInteractionPolicy`/`RuleBasedInteractionPolicy` on edge until proven, VAP on Node first.
- **Latency (REQ-9):** a per-frame learned model on the hot path is the core risk; mitigation — hard p99 gate,
  A/B smoke, abort criteria (§11).
- **Field non-convergence:** the native single-model camp (BayLing-Duplex, FLM-Audio) may prove superior;
  mitigation — the seam makes a native full-duplex *conductor* (Moshi/MoshiRAG) a future `DeferInteractionPolicy`
  front, so the decoupled bet is not a dead end even if native wins.
- **Residual limit (honest):** a native full-duplex model conditions response *content* on paralinguistics in
  one shared latent stream; our controller+generator seam passes only a compressed summary, so it matches
  *timing* (VAP proves) but not continuous *semantic* conditioning on raw audio. This is a two-way tradeoff,
  not a deficit — native E2E duplex "struggles with semantic consistency" (arXiv:2510.02066), the exact
  weakness the delegated design avoids. The maximal escalation (future, not this RFC) is an open full-duplex
  conductor (Moshi arXiv:2410.00037; MoshiRAG 2026) with delegated reasoning.

### Alternatives considered
- **Native single-model full-duplex (bundle interaction+generation).** Rejected as the primary bet: it is
  model-locked (kills the model-agnostic wedge) and pays a reasoning-consistency cost (arXiv:2510.02066).
  Retained as a future conductor option via the same seam.
- **Rules-only (keep the three owners, add backchannels).** Rejected: the lit review shows rule-based turn
  detection cannot match learned timing/backchannel quality; it also leaves the interaction logic smeared.
- **Fuse the policy into `RealtimeBridge` only.** Rejected: would not serve the cascade path (REQ-3) — the
  seam must be core-level.
