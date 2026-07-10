# Proceed evidence — `IP-C3` backchannel wait-gap cue layer

**Verdict:** **PROCEED** · **Manager:** Opus 4.8 (1M), 2026-07-10
**Commit:** `328db80 [IP-C3]` on `plan/ip-vap` · **Worker:** grok · Governed by the codex decision doc.

## Verified
- Manager re-run: `pnpm -r --filter './packages/*' typecheck` **0**; C3-touched packages green —
  `core` **266** (256 + C3 tests), `server-websocket` **241** (+ one-shot cue tests). `cf-agents` green
  (no C3 change). Guard tests (`turn-arbiter.test`, `characterization`) byte-unchanged; my C1/C2/C4 guards intact.
- **The one `pnpm -r test` red was a load flake, NOT C3:** `packages/grok` STT test
  "waits for transcript.created before sending binary audio" failed once under full-parallel load, then
  passed **4/4 in isolation** (13/13). Same class as the documented IU server-workers workerd-boot flake.
  C3 does not touch `packages/grok`. **Pre-existing flake — flagged as a CI risk (CI runs `pnpm -r test`).**

## Faithful to the decision (`research/interaction-policy/c3-backchannel-decision.md`) + brief
- **Rule-based gap state machine:** one cue (`mm_hmm`) on the G3 `tool_call_cue.delayed` phase only;
  gated on `!delegateCuePlayed && !ttsActive && !userSpeaking`; cleared on `complete`/`failed`.
  **No user-pause/mid-utterance backchannels** (verified in the diff + grok's `no VAD/user-pause` test).
- **G3 fed into the policy** (not a second event path): the session's `tool_call_cue` emitter also pushes a
  `delegate_state` observation carrying `toolCallPhase`.
- **Coordinator gating + metrics:** `candidate` then suppress on `emitsBackchannel`/`tts_active`/
  `user_speaking`/`missing_asset` (each metered), else emit `interaction.backchannel` + `emitted`.
- **Composes with the v4.1 thinking bed:** one-shot cue mixed over the bed with `CUE_THINKING_DUCK` — no
  double audio, bed untouched.
- **Metric honesty:** `turn_latency.backchannelUsed` added (the `fillerUsed` precedent) via
  `onBackchannelEmitted`.

## Cloudflare / dual-runtime (the maintainer's concern) — satisfied by construction
- Cues are **byte config**: `BackgroundAudioConfig.cues?: Record<cueId, BackgroundAudioSource>` (raw PCM),
  resolved by lookup — **the mixer/core never reads a filesystem**. Placeholder cues are generated
  **in-memory** (`buildPlaceholderBackchannelCues`, no fs).
- On CF, cues ride the **existing `backgroundAudio` passthrough** (cf-agents `with-voice.ts:428/454` already
  forwards the whole `BackgroundAudioConfig`) — the app supplies bytes at init from a bundled import or R2.
  **No cf-agents change was needed**, which is why the diff doesn't touch it.

## Follow-ups (documented, not blockers)
- Real voice-matched recorded cues + a locale table (placeholders now).
- Manager listen-smoke deferred: placeholder tones make "hearing mm_hmm" meaningless; the render path is
  unit-verified (one-shot cue audible in an idle frame). Run the listen smoke once real cues land.

## Decision
**PROCEED.** C3 lands the conservative asset-backed wait-gap cue layer exactly as decided — CF-neutral,
behavior-preserving, composing with the thinking bed, with the learned-timing case correctly deferred to VAP.
