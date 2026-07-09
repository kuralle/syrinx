# Story Brief — `IP-C3` backchannels: conservative asset-backed wait-gap cue layer

> **You are the IC engineer (`grok` worker — fresh process, clean context).** Self-contained. If anything
> contradicts disk, **STOP** → `.handoff/blocked-ip-c3.md`.
>
> **Branch:** the current `plan/ip-vap` lineage (has C1+C2+C4+C5). **Commit:** one atomic
> `[IP-C3] backchannel wait-gap cue layer`. No push, no main. **Proof:** `.handoff/proof-ip-c3.json`.
> **Do NOT run any live smoke** (the manager runs the listen smoke).

## 0. READ THIS FIRST — the decision that governs this chunk

**`research/interaction-policy/c3-backchannel-decision.md`** — this is the authoritative design decision for
C3 (a researched call on how backchannels should work in Syrinx). **Read it fully before touching code; it
governs every choice below.** Its §"Recommendation For Syrinx" and §"Implementation Sketch" are your spec.
Key rulings you must honor:
- C3 is a **conservative wait-gap cue layer that composes with the shipped v4.1.0 thinking bed** — NOT a
  broad conversational-backchannel system. The thinking bed stays the continuous "alive" signal; a discrete
  cue is the sparse "still with you" signal, mixed over the bed with brief ducking (no double audio).
- Cues are **pre-cached, voice-matched PCM assets** rendered via `BackgroundAudioMixer` — **no runtime TTS
  round-trip** on the cue path (REQ-9). `InteractionDecision.backchannel.cue` is a stable **cue id**, not
  arbitrary text.
- **Do NOT add free-form filler fields to tool-call schemas.** Use the InteractionPolicy `backchannel`
  decision + the existing G3/`onToolCallStart` hooks. (This was an explicitly-rejected alternative.)
- **Rule-based mode emits NO user-pause/mid-utterance backchannels** (a silence timer fakes a VAP; mistimed
  backchannels are worse than none). It emits **at most one** cue per delegate gap, on the G3
  `tool_call_cue.delayed` phase only.
- VAP (C5, already built) owns continuous listener-backchannel timing later — NOT this chunk.

Then read: `docs/rfc-interaction-policy-seam.md` §4.5 (`InteractionBackchannelPacket`), §6/§12-Q2;
`packages/core/src/interaction-policy.ts`, `interaction-coordinator.ts`, `policies/rule-based.ts` (the seam
from C1); `packages/server-websocket/src/background-audio.ts` (the mixer + `wireBackgroundThinking` + the G3
`tool_call_cue` lifecycle); `packages/core/src/voice-agent-session.ts` (the `tool_call_cue` emitter +
`delayCueAfterMs` default 2000 + the `fillerUsed` metric precedent); `packages/cf-agents/src/with-voice.ts`
(`backgroundAudio` config + `onToolCallStart`).

## 1. Scope (follow the decision doc's Implementation Sketch)

### 1a. Core — packet + observation + coordinator
- `packages/core/src/packets.ts`: add `InteractionBackchannelPacket { kind: "interaction.backchannel"; contextId; timestampMs; cue: string }` (Route.Main) + a factory. Add the kind to the union/exports.
- `packages/core/src/interaction-policy.ts`: extend the `delegate_state` observation (or add a narrow field)
  with `toolCallPhase?: "started" | "delayed" | "complete" | "failed"` — do NOT invent a second event path.
  Keep `InteractionDecision.backchannel.cue` as a cue id (document it).
- `packages/core/src/interaction-coordinator.ts`: feed the G3 `tool_call_cue` lifecycle into the policy as
  `delegate_state` observations carrying `toolCallPhase`. On a `backchannel` decision, push
  `interaction.backchannel` **only if `!caps.emitsBackchannel`**. Emit suppression metrics:
  `backchannel.candidate`, `backchannel.emitted`, `backchannel.suppressed_caps`,
  `backchannel.suppressed_tts_active`, `backchannel.suppressed_missing_asset`,
  `backchannel.suppressed_user_speaking`.

### 1b. Rule policy — the gap state machine (`packages/core/src/policies/rule-based.ts`)
- Keep ALL existing interruption behavior unchanged (do not touch the arbiter path).
- Add a tiny delegate-gap state machine: on `toolCallPhase:"started"` mark gap-open + cue-not-played; on
  `"delayed"` if gap-open && cue-not-played → return **one** `{ kind:"backchannel", cue:"mm_hmm" }` and mark
  played; on `"complete"|"failed"`/reset → clear. **Never** inspect user silence/VAD for backchannel emission.
  Suppress if assistant TTS is active or the user is speaking (the coordinator also gates, but keep the
  policy conservative).

### 1c. Render — mixer + transports
- `packages/server-websocket/src/background-audio.ts`: add a **one-shot cue** source path (separate from the
  looped ambient/thinking sources), mixed through the same PCM/resample/clip path, with a brief duck/fade of
  the thinking bed under the cue so "mm-hmm" is intelligible.
- The server outbound path(s) that own the mixer: listen for `interaction.backchannel`, resolve the cue id →
  active voice/locale PCM asset, queue the one-shot cue. If no asset for the voice/locale → suppress (emit
  `backchannel.suppressed_missing_asset`), do not error.
- `packages/cf-agents/src/with-voice.ts`: pass optional backchannel cue assets through the existing
  `backgroundAudio` config (NOT a new top-level mechanism). Leave `onToolCallStart` as-is.

### 1d. Assets (placeholder — real voice-matched cues are a follow-up)
- Add a small set of **pre-rendered** mono PCM16 cue assets (`mm_hmm`, `yeah`, `got_it`), 250–900 ms,
  gain-normalized, trimmed. For this chunk, **generate deterministic placeholder PCM** (a short shaped tone
  or a synthesized clip rendered offline in a build step) bundled with the package — clearly documented as
  placeholders. **No runtime network TTS.** Real recorded/voice-matched cues + a locale table = a documented
  follow-up (mirror the existing "generated placeholder ambience" precedent).

### 1f. Cue asset delivery — runtime-neutral / Cloudflare-compatible (LOAD-BEARING — REQ-10)

The mixer and core MUST treat cues as **byte-based config sources**, exactly like the existing thinking bed
(`BackgroundAudioSource = { pcm: Int16Array; sampleRateHz; gain? }`). **The mixer/core NEVER reads a
filesystem** — Cloudflare Workers (`withVoice(Agent)`) has no filesystem, and the thinking-bed PCM already
reaches the edge as config bytes today. So:
- Add cues to `BackgroundAudioConfig` as a **byte map**, e.g. `cues?: Readonly<Record<string, BackgroundAudioSource>>`
  (cue-id → PCM bytes). Resolution of `interaction.backchannel.cue` (+ active voice/locale) is a **lookup in
  this config-supplied map**, not a path read. No entry → suppress (`backchannel.suppressed_missing_asset`).
- `cf-agents/src/with-voice.ts`: cues flow through the existing `backgroundAudio` config (bytes the app
  supplies at session init — a bundled Worker binary import OR fetched from R2/KV, both already available on
  the edge; cf-agents already ships R2 infra). **Loaded once at init, cached in the mixer — never on the cue
  hot path.**
- The Node/server-websocket + example layer MAY read bundled placeholder cue files (`readFileSync`) and pass
  the bytes in — but that convenience lives ONLY in the Node host/example, never in the mixer/core. The same
  `cues` config drives both runtimes identically.
- Keep cues SMALL so a bundled Worker import is viable: mono PCM16 at **16 kHz** (250–900 ms ≈ 8–29 KB each;
  a handful per voice = tens of KB total). Do NOT use 48 kHz cues.
- Add a test asserting cue resolution works from config bytes with **no filesystem access** (i.e. the core/
  mixer path is fed `cues` bytes directly), proving the CF path.

### 1e. Metric honesty
- Extend the `turn_latency`/metrics so a cue's audio is **not** counted as the first relevant answer — mirror
  the existing `fillerUsed` flag precedent (see `LatencyFillerController` + `turn_latency.fillerUsed`).

## 2. Acceptance criteria — tests
**Pass-to-pass (unchanged, green):** all existing core + server-websocket + cf-agents suites; the barge-in
characterization + turn-arbiter tests **byte-unchanged**. `pnpm -r --filter './packages/*' typecheck` +
`pnpm -r test` exit 0 (only the known pre-existing example playwright failure allowed).

**Fail-to-pass (new):**
- rule-based: NO backchannel on VAD/user-pause observations; exactly ONE cue on `started→delayed`;
  `complete`/`failed`/reset clears; conservative suppression when TTS active / user speaking.
- coordinator: `backchannel` decision → `interaction.backchannel` packet; **suppressed when
  `caps.emitsBackchannel`**; suppression metrics fire for each gate.
- mixer: one-shot cue audible in an idle frame; thinking loop continues before/after; no cue when no source;
  clipping bounded.
- session/server: a simulated `tool_call_cue.delayed` produces `interaction.backchannel` end-to-end.

## 3. What NOT to do
- Do NOT replace the thinking bed; do NOT emit at `tool_call_cue.started` (bed's job); do NOT repeat cues by
  default; do NOT add free-form filler fields to tool schemas; do NOT do runtime TTS on the cue path; do NOT
  emit backchannels from user pauses in rule-based mode; do NOT edit existing characterization tests.
- No `--no-verify`, `@ts-ignore`, `as any`, silent catch.

## 4. Proof
Save the new-test output to `sprints/interaction-policy/artifacts/ip-c3.txt`. `.handoff/proof-ip-c3.json`:
`commands_run` (typecheck + core/server-websocket/cf-agents test, exit 0), `claims[]` (each with `type`),
`satisfies_assertions` = `["REQ-4","REQ-6","test:rule-no-user-pause-bc","test:one-cue-on-delayed","test:coordinator-emitsBackchannel-gate","test:mixer-oneshot-cue"]`,
`files_changed`, `demo_artifact`, `notes` (state that cues are PLACEHOLDER assets + the real-cue follow-up).
Commit `[IP-C3] backchannel wait-gap cue layer`. Exit — no PR.

## 5. If stuck
If composing the one-shot cue with the thinking bed can't be done without double audio or a behavior change
to the bed, or if the G3 lifecycle can't be fed to the policy cleanly, STOP → `.handoff/blocked-ip-c3.md`
with the exact obstacle. Do NOT fall back to runtime TTS or a user-pause trigger.
