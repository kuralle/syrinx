# Scope — Slice D: Phone-line turn quality

Status: **Ready to implement** (both sub-tasks are unit-provable now, no external dep).
Tasks: `e80cf646` (min-speech guard), `aa669c0e` (loudness/AGC on outbound audio).
Sizing: **S** each; independent; can be one worker, two commits.

---

## D1 — Minimum-speech guard on endpoint fusion (`e80cf646`)

### Problem
`fuseEndpointDecision(smartTurnComplete, semantic, config)`
(`packages/pipecat-smart-turn/src/semantic-completeness.ts:111`) fuses only TWO signals —
acoustic completeness AND semantic completeness. A brief cough/noise burst that trips both
falsely endpoints. AssemblyAI and LiveKit both add a **min-speech** condition (3-way AND).

### Design
1. Thread **accumulated speech duration** for the current turn from `PipecatEOSPlugin` into the
   fusion. The plugin already sees VAD frames; if it does not already keep a per-turn speech-ms
   accumulator, add one (reset on turn start, increment on voiced frames). Surface it to the
   caller that invokes `fuseEndpointDecision`.
2. Extend `SemanticEndpointFusionConfig` with `minSpeechMs?: number` (default `0` = current
   behavior preserved — critical: no regression for existing configs).
3. Add a 3rd parameter `speechMs: number` to `fuseEndpointDecision`. The positive-endpoint branch
   (`smartTurnComplete && semantic.complete`) becomes
   `smartTurnComplete && semantic.complete && speechMs >= config.minSpeechMs`.
   When min-speech fails, return the non-release decision (same shape as the current "not complete" path).

### Interface change (pin)
- `fuseEndpointDecision(smartTurnComplete: boolean, semantic: SemanticCompletenessScore, speechMs: number, config: SemanticEndpointFusionConfig)`
  — new required `speechMs` arg (update the single call site) OR add it to `config` if threading a
  4th positional is awkward at the call site. Prefer the positional arg; keep `config` for tunables.
- `SemanticEndpointFusionConfig.minSpeechMs?: number` (default 0).

### Files
- `packages/pipecat-smart-turn/src/semantic-completeness.ts` (fusion + config)
- the plugin that calls it + tracks VAD frames (`packages/pipecat-smart-turn/src/*.ts` — find the
  call site of `fuseEndpointDecision`)
- colocated `*.test.ts`

### Test plan
- sub-threshold speech burst (`speechMs < minSpeechMs`) with both other signals true → does NOT release.
- normal utterance (`speechMs >= minSpeechMs`) with both true → releases.
- `minSpeechMs` unset/0 → identical to current behavior (regression guard).

---

## D2 — Loudness/gain normalization on outbound audio (`aa669c0e`)

### Problem
A voice agent sounds fine in a browser but flat/quiet on a phone leg (the carrier compresses).
The one genuinely engine-level, provider-agnostic fix is **loudness normalization on the assistant
PCM** before it hits the transport. (Number verbalization = prompting; pronunciation = provider dict;
SSML = per-provider — all OUT of scope. This is only the DSP piece.)

### Design
1. Add a small, dependency-free normalization stage operating on `Int16` PCM frames: target a
   consistent RMS/LUFS-ish level with a conservative ceiling (no clipping — soft-limit, do not hard-clamp
   into distortion). A running-gain approach (estimate frame RMS, move gain toward target with a slew
   limit) is enough; full EBU-R128 LUFS is over-engineering for this slice.
2. Insert it on the outbound path where assistant PCM is handled: `tts.audio` →
   `handleTtsAudio` (`packages/core/src/voice-agent-session.ts:708`) advances the playout cursor and
   forwards audio. Normalize the chunk there, BEFORE it is forwarded to transport/recording.
3. **Opt-in per session/transport** — telephony legs benefit; the browser leg already has
   getUserMedia AEC/gain. Config flag (e.g. `outboundLoudness?: { targetRms: number } | false`),
   default off so existing behavior is unchanged.

### Interface change (pin)
- New module `packages/core/src/audio/loudness.ts` (or under existing `packages/core/src/audio/`):
  `export function normalizeLoudness(pcm: Int16Array, state: LoudnessState, cfg: LoudnessConfig): Int16Array`
  plus a `createLoudnessState()` factory (per-session running gain).
- Session config gains an optional `outboundLoudness` field; when set, `handleTtsAudio` runs the chunk
  through `normalizeLoudness` before forwarding.

### Files
- `packages/core/src/audio/loudness.ts` (NEW) + test
- `packages/core/src/voice-agent-session.ts` (wire into `handleTtsAudio`, gated by config)
- `packages/core/src/audio/index.ts` (export)

### Test plan
- a quiet PCM buffer is brought up toward target RMS; a loud one is brought down; neither clips
  (max sample within Int16 range, no wrap).
- config off → PCM passes through byte-identical (regression guard).
- two synthetic buffers at different input levels converge to within a tolerance band of each other
  (the "consistent across providers whose native loudness differs" property).

### Adjacent prior art in-repo
- WSOLA tempo DSP (`packages/openai-tts/src/wsola.ts`) — same Int16 PCM frame handling conventions to mirror.

---

## Note on ordering vs Slices A–C
D2 touches `voice-agent-session.ts` (`handleTtsAudio`) — the same file A's spend-cap was fenced OFF of.
Schedule D2 AFTER Slices A–C land to avoid a merge conflict on that file. D1 is in `pipecat-smart-turn`,
collision-free — can land any time.
