# Scope — Slice E: Dynamic STT reconfig + conversation-state context biasing (the moat)

Status: **Ready to implement** (design below). Task: `8a69b81d` (currently `scope`).
Sizing: **M–L**. Touches the plugin contract + Deepgram Flux + InteractionPolicy wiring + a session
hook. This is the differentiator that requires owning BOTH reasoner and STT — worth doing right.

---

## Why this is the moat
Vapi/ElevenLabs orchestrate someone else's STT; AssemblyAI is the STT but doesn't own the reasoner.
Syrinx owns both, so it can tighten endpointing + bias keyterms **for one turn** based on what the
agent just asked ("what's your account number?" → numeral biasing + tighter EOT that turn only).
Nobody who only orchestrates can copy it without becoming an orchestrator.

## Current state (grounded)
- Deepgram Flux bakes keyterms + endpointing into the WebSocket URL **once at connect**
  (`packages/deepgram/src/flux.ts:109` `url()` builder — `eot_threshold`, `eager_eot_threshold`,
  `eot_timeout_ms`, `keyterm` params). No mid-stream reconfigure.
- The plugin contract (`packages/core/src/plugin-contract.ts`) has `EndpointingCapability` as a
  read-only owner tag (`owner: "provider_stt" | "smart_turn"`). **No `reconfigure` capability exists.**
- `InteractionPolicy` (`packages/core/src/interaction-policy.ts`) already observes the turn context
  (`stt_partial`/`stt_final`/vad events) and returns decisions — but it is **advisory only**; nothing
  lets it actuate STT config.

## Design

### E1 — `reconfigure` capability on the STT plugin contract
Add an optional capability to `VoicePlugin`:
```ts
export interface SttReconfigure {
  reconfigure(partial: {
    keyterms?: readonly string[];
    eotThreshold?: number;
    eagerEotThreshold?: number;
    vadThreshold?: number;
  }): Promise<void> | void;
}
```
- Expose via an optional field (e.g. `sttReconfigure?: SttReconfigure`) so adapters that can't do it are
  simply absent (same pattern as `endpointingCapability?`).
- **Deepgram Flux** implements it: if Deepgram's live protocol supports an in-band settings update
  message (verify against current Deepgram v2 `listen` docs via Context7/live docs — do NOT assume),
  send it on the open socket **without restart** (AssemblyAI-style `UpdateConfiguration`). If the
  provider genuinely cannot update mid-stream, the honest fallback is a fast reconnect with the new URL
  params keyed to a turn boundary — but **document which path is taken**; do not silently no-op.

### E2 — Make InteractionPolicy actuating
- Extend the policy decision surface with an optional `sttReconfigure?: { … }` field (the same partial
  shape as E1). The coordinator that consumes policy decisions calls the plugin's `reconfigure` when
  present. The policy already knows the turn context, so this is wiring, not new intelligence.
- Keep it OPTIONAL and additive — existing policies that don't set it are unaffected.

### E3 — Conversation-state context biasing
- Feed the agent's last answer / expected-answer shape into the biasing decision. Minimal first cut:
  when the agent's last turn ends in a question whose expected answer is structured (account number,
  date, email, yes/no), bias keyterms + tighten EOT for the next user turn only, then revert.
- Prior-art nuance to honor: AssemblyAI's keyterm guidance is **contextual sentences, not bare terms** —
  the biasing payload should carry phrase context where the provider supports it.
- First cut can be a small rule table (question-shape → bias profile); the InteractionPolicy is the
  right home. Do NOT bake an LLM classifier into core for v1 — that's a later refinement.

## Interface changes (pin)
- `plugin-contract.ts`: `SttReconfigure` interface + optional `sttReconfigure?` on the plugin.
- `interaction-policy.ts`: optional `sttReconfigure?` on the decision type.
- `interaction-coordinator.ts`: on a decision carrying `sttReconfigure`, invoke the plugin capability.
- `packages/deepgram/src/flux.ts`: implement `reconfigure`; refactor the URL param builder so keyterms/
  thresholds are instance state that both `url()` and `reconfigure()` read (single source of truth).

## Files
- `packages/core/src/plugin-contract.ts`
- `packages/core/src/interaction-policy.ts`, `packages/core/src/interaction-coordinator.ts`
- `packages/deepgram/src/flux.ts` (+ `stt.ts` if the non-Flux path should also support it)
- colocated tests

## Test plan
- unit: a policy decision carrying `sttReconfigure` causes the coordinator to call the plugin's
  `reconfigure` with the exact partial; a decision without it never calls reconfigure.
- unit (flux): `reconfigure({ keyterms })` updates instance state so a subsequent `url()` reflects it
  (single-source-of-truth guard), and the in-band update path (or documented reconnect) is exercised.
- **live proof (MANAGER):** on cascade, an "account number?" turn measurably tightens endpointing /
  improves numeral recognition vs the prior turn. This is the acceptance signal from the task; it needs
  live Deepgram + the cascade smoke, so it is a manager step, not a worker unit test.

## Risks / open verification
- **Does Deepgram Flux v2 actually support mid-stream reconfigure?** MUST verify against current docs
  (Context7 `deepgram` / live docs) before committing to the no-restart path. If not, the reconnect
  fallback is the honest design — but it costs a reconnect per reconfigure, so gate it to real
  question-turns only.
- Reconnect-on-reconfigure must be keyed to a turn boundary to avoid dropping audio mid-utterance.

## Recommendation
Split into two board tasks when released: **E-a** = `reconfigure` capability + Flux impl + actuating
InteractionPolicy wiring (the mechanism); **E-b** = conversation-state biasing rules (the intelligence).
E-a is the reusable seam; E-b is the first consumer. Ship E-a first, live-prove with a hand-set bias,
then add E-b.
