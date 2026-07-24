# stt-core migration — Wave 1 implementation notes

Task: `01011923` — Migrate remaining STT providers onto stt-core.
Wave 1 scope: extend stt-core into an extensible base + migrate **ElevenLabs, Google, Deepgram Flux**.
Nova (Finalize state machine) is Wave 2. Delegated to grok-4.5; reviewed + fixed + verified by the manager.

## Design (the "one base, providers extend" directive)

`stt-core` is the shared streaming-STT lifecycle. A provider is a thin `SttWireProtocol`; provider-specific
behavior is expressed through **optional seams**, not a parallel reimplementation:

- `encodeAudio?(audio) → SocketData[]` — default raw `[audio]` (Grok/Deepgram/Google/Flux); ElevenLabs JSON-wraps.
- `onOpen?() → SocketData[]` — config/handshake frames, sent on every (re)connect **before replay** (wired via
  `WebSocketConnection.onReadyBeforeReplay`). Google `sendConfig`.
- `encodeReconfigure?(partial) → SocketData[]` — mid-stream reconfigure (Flux `Configure`).
- `StreamingSttSession.reconfigure(partial)` / `reset()` — Flux uses `reconfigure`; nova (Wave 2) will use `reset`.
- Richer `SttEvent` vocab: `speech_started` → `vad.speech_started`, `partial`(wordTimings) → `stt.partial`,
  `eos_interim` → `eos.interim`, `eos_retracted` → `eos.retracted`. Turn-aware providers (Flux) survive intact.
- **Sent-bytes billing fallback (SttEngine):** bill provider `event.audioSeconds` delta when present, else
  `bytes/2/sampleRate` delta from outbound audio the engine already sees. Duration billing advances the byte
  marker so a later no-duration final cannot double-bill (mirrors the old Google offset-else-bytes logic).

## Load-bearing bug caught in review + fixed (manager)

**Double-send / double-bill via `user.audio_received` (regression for Google + Flux).** The stt-core session
(inherited from the Grok build wave) subscribed to BOTH `stt.audio` and `user.audio_received`. But
`VoiceAgentSession.handleUserAudio` (`packages/core/src/voice-agent-session.ts:837/844`) unconditionally fans
every `user.audio_received` frame out to `stt.audio`. So a both-subscriber sends + bills every frame **twice**
in any real session. Old Google/Flux subscribed to `stt.audio` **only** (like the canonical nova plugin at
`packages/deepgram/src/stt.ts:225`), so the migration would have introduced a 2× audio-send + 2× usage-bill
regression for them. The live spike harnesses push `stt.audio` directly (bypassing the fan-out), which masked it.

Fix: `packages/stt-core/src/session.ts` now subscribes to `stt.audio` **only** — the framework's canonical STT
ingress. This also removes the same latent double-bill for Grok and ElevenLabs. Verified: EL/Grok live smokes
bill 8.98s (not ~18s) for a ~9s fixture; stt-core 15 tests green; full `-r typecheck` = 0.

## Accepted minor deviations (documented, low severity — not blocking)

- **`contextId: ""` on some Background metrics + Flux reconfigure-failure error.** The migrated plugins no longer
  own `currentContextId` (the session engine does), so `metric.conversation` (Google `stt_low_confidence`,
  Flux `configure_success/failure`, reconnect-replay) and the Flux reconfigure-error now carry `contextId: ""`.
  Name/value/behavior otherwise identical; billing + transcripts unaffected. Restoring the live turn id would
  require the session to expose `currentContextId` — deferred as an observability-fidelity follow-up.
- **Flux audio now passes `assertAudioPayload`.** Passing `format` to the session (mandatory for byte-billing)
  couples in payload validation; old Flux forwarded raw audio unvalidated. Well-formed PCM16 is unaffected; a
  malformed/odd-length frame is now dropped + surfaced as `stt.error` (consistent with EL/Google). Accepted as a
  correctness improvement.
- **Additive signals (not regressions):** all three now surface `onUnrecoverable → stt.error`; ElevenLabs gains a
  `stt.elevenlabs.reconnect_replay_*` metric. New signals only.

## Verification

- `pnpm -r typecheck` = 0.
- `pnpm --filter @kuralle-syrinx/{stt-core,elevenlabs,google,deepgram} test` all green (stt-core 15).
- Live (manager-run): ElevenLabs STT (transcript + usage 8.98s via byte-billing), Deepgram Flux (full turn
  machine — interim/eager-eos/retract/eos.turn_complete + speculative-gen end-to-end), Grok STT regression
  (duration billing 8.98s, unchanged). Google STT not live-testable here (no GCP service account); rests on
  package tests + behavior-preservation diff review.
