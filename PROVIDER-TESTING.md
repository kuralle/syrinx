# Provider Testing Guide — Syrinx Voice Engine

Grounded in real scripts and handoff docs as of `2026-05-30`. Every command matches a `scripts` entry in
`examples/02-hello-voice-headless/package.json`. Every provider-doc URL is cited from `VOICE-ENGINE-HARDENING.md`
Sources or `TELEPHONY-VOICE-HANDOFF.md`; claims without a verifiable source are marked **UNVERIFIED**.

---

## 1. Prerequisites

### Environment variables (`.env` at repo root)

| Variable | Provider | Required by |
|---|---|---|
| `DEEPGRAM_API_KEY` | Deepgram STT | All live smokes |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini LLM + optional TTS | All live smokes |
| `CARTESIA_API_KEY` | Cartesia TTS | Interactive/recorder/telephony smokes, Fly spike |
| `CARTESIA_VOICE_ID` | Cartesia TTS | Same as above |

The canonical env var for the AI SDK Google package is `GOOGLE_GENERATIVE_AI_API_KEY` (see `TELEPHONY-VOICE-HANDOFF.md`
fly-secrets block and `examples/02-hello-voice-headless/package.json`'s `@ai-sdk/google` dependency).
`GEMINI_API_KEY` is an alternative alias — **UNVERIFIED** that the AI SDK accepts it; use
`GOOGLE_GENERATIVE_AI_API_KEY` unless you confirm otherwise.

### Local tools

| Tool | Needed for | Install hint |
|---|---|---|
| `pnpm` | All commands | `npm i -g pnpm` |
| `whisper` CLI | `smoke:live-recorder-coherence` (Whisper `tiny.en` audit) | `pip install openai-whisper` |
| `flyctl` (`fly` CLI) | `smoke:fly-synthetic-carrier` | https://fly.io/docs/hands-on/install-flyctl/ |
| Docker daemon | `smoke:fly-synthetic-carrier` (`fly deploy` builds an image) | Docker Desktop or equivalent |

### Build check before any smoke

```bash
pnpm -r typecheck
pnpm -r test
```

---

## 2. Per-Provider Contract and Exact Smoke Commands

### 2.1 Deepgram STT

**Provider contract:** Persistent WebSocket for the session lifetime; `KeepAlive` text frames during
idle/post-turn playout; provider `Finalize` control frame sent only after Smart Turn approves a boundary;
transcript released only after provider replies with `speech_final: true` or `from_finalize: true`; `CloseStream`
sent only on session shutdown. Provider `NET-*` close reasons are recoverable reconnects; `DATA-*` close reasons
are fatal. Stale transcript/finalize/audio-delivery state is discarded before any reconnect socket opens.

**Official docs (from `VOICE-ENGINE-HARDENING.md` Sources):**
- Keep-Alive: https://developers.deepgram.com/docs/audio-keep-alive
- CloseStream: https://developers.deepgram.com/docs/close-stream

**Exercises Deepgram directly:**

```bash
# Package-level unit + integration tests (mock provider socket)
pnpm -r test

# Live 3-turn interactive smoke (Deepgram nova-3, Gemini agent, Cartesia TTS)
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-interactive

# Live 24-turn longform smoke (Deepgram nova-3, Gemini agent, Gemini TTS)
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-university

# Live 3-turn recorder coherence with Whisper audit
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:live-recorder-coherence
```

**Artifact paths written:**
- `examples/02-hello-voice-headless/test/performance/runs/websocket-university-interactive-<ts>/manifest.json`
- `examples/02-hello-voice-headless/test/performance/runs/websocket-university-<ts>/manifest.json`
- `examples/02-hello-voice-headless/test/performance/runs/live-university-recorder-<ts>/baseline.json`

**Passing proves:** Live Deepgram `nova-3` STT completes turns with Smart Turn + provider `Finalize` handshake,
delivers `is_final` transcripts, and emits `stt_provider_finalize_requested` → `stt_provider_final_buffer_released`
in that order. Avg STT final after audio end: ~914 ms (interactive baseline, `2026-05-30`).

**Does NOT prove:** Deepgram account tier rate limits, language/model variants beyond `nova-3`, or what happens
if the Deepgram WebSocket closes mid-turn on a production account.

---

### 2.2 Gemini LLM

**Provider contract:** AI SDK streaming via `@ai-sdk/google`; bridge records provider finish reasons and
fails the turn (instead of emitting `llm.done`) when Gemini ends with `length`, `content-filter`, `error`,
`tool-calls`, `other`, or missing finish metadata. University profile token budget: 1024 interactive /
1400 longform. Default model: `gemini-2.5-flash` (`SYRINX_DEEPGRAM_MODEL`/`SYRINX_DEEPGRAM_LANGUAGE` are
configurable).

**Official docs:** **UNVERIFIED** — no Gemini/Google AI SDK URL appears in `VOICE-ENGINE-HARDENING.md` Sources.
Confirm against the `@ai-sdk/google` package docs or https://ai-sdk.dev (not yet verified in this repo).

**Exercises Gemini directly:**

```bash
# Generates user-side WAV fixtures from Gemini TTS (also validates Gemini LLM access)
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless fixtures:gemini-university

# Live 3-turn interactive smoke
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-interactive

# Live 24-turn longform
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-university
```

**Artifact path:** `examples/02-hello-voice-headless/test/performance/runs/websocket-university-<ts>/manifest.json`

**Passing proves:** Gemini streams text, does not end with a truncation finish reason, and produces non-empty
agent replies with tool calls across multi-turn conversations. Avg LLM first text after STT final: ~3.6 s
(free-tier; paid/low-latency setup still needed to approach sub-second target per `HANDOFF.md`).

**Does NOT prove:** Paid Gemini tier latency, grounding, or function-calling beyond the university-support fixture.

---

### 2.3 Cartesia TTS

**Provider contract:** Persistent WebSocket connection; API key sent in `X-API-Key` header (not URL).
Each utterance uses one stable `context_id`. Turn end sends an empty terminal continuation with `continue: false`
(`flush: true`). Interruption sends `{ context_id, cancel: true }`. Provider `flush_done` acknowledgement
carries an empty `data` string (control frame, not audio). Late `data`/`done` frames for cancelled contexts
are suppressed.

**Official docs (from `VOICE-ENGINE-HARDENING.md` Sources):**
- Cartesia TTS WebSocket + contexts: https://docs.cartesia.ai/api-reference/tts/websocket

**Exercises Cartesia directly:**

```bash
# Live 3-turn interactive (Cartesia is the interactive-review TTS path when CARTESIA_API_KEY is set)
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-interactive

# Live 3-turn recorder coherence with Whisper audit (Cartesia TTS)
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:live-recorder-coherence

# Live telephony adapter smoke with Cartesia TTS (pick a provider)
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=twilio pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telephony-university-live
```

**Artifact path:** `examples/02-hello-voice-headless/test/performance/runs/websocket-university-interactive-<ts>/manifest.json`

**Passing proves:** Cartesia header auth works, context lifecycle (send → terminal flush → cancel) follows provider
contract, `flush_done` is not mis-decoded as audio, first Cartesia audio arrives within ~408 ms of first agent
text (interactive baseline). Latest live header-auth result: 13 chunks / 50,526 PCM bytes for a short utterance
(`2026-05-28`).

**Does NOT prove:** Cartesia account bandwidth limits, non-English voice IDs, or streaming at rates above current
fixture load.

---

### 2.4 Twilio

**Provider contract:** `<Connect><Stream>` TwiML; carrier opens a `wss://` bidirectional stream. Inbound:
PCMU/8 kHz/mono. Outbound: paced 20 ms PCMU `media` frames. Interruption: adapter locally clears queued
playout and sends Twilio `clear`. Playback evidence: `mark` sent only after the paced batch drains; terminal
end mark stays pending until all prior playback marks are acknowledged.

**Official docs (from `TELEPHONY-VOICE-HANDOFF.md`; NOT in `VOICE-ENGINE-HARDENING.md` Sources):**
- TwiML Stream: https://www.twilio.com/docs/voice/twiml/stream
- WebSocket messages: https://www.twilio.com/docs/voice/media-streams/websocket-messages

**Emulator smoke (no live provider, no credentials):**

```bash
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:twilio-emulator
```

Artifact: `examples/02-hello-voice-headless/test/performance/runs/twilio-emulator-<ts>/manifest.json`

Latest result: 7 inbound phone frames / 1,120 PCMU wire bytes / 4,480 normalized PCM bytes, 12 outbound
paced PCMU frames, 2 marks (including terminal end mark after playback-mark ack), quality gate passed.

**Live-provider adapter smoke (real STT/LLM/TTS, emulated Twilio carrier):**

```bash
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=twilio pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telephony-university-live
```

Artifact: `examples/02-hello-voice-headless/test/performance/runs/telephony-university-live-twilio-<ts>/baseline.json`
Also writes: `carrier-inbound.wav`, `carrier-outbound.wav`, `whisper/carrier-inbound/`, `recorder/twilio/manifest.json`

**Real Twilio carrier call (needs account credentials):**

```bash
TWILIO_ACCOUNT_SID=AC... \
TWILIO_AUTH_TOKEN=... \
TWILIO_FROM_NUMBER=+15551234567 \
TWILIO_TO_NUMBER=+15557654321 \
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:twilio-carrier-call
```

Artifact: `examples/02-hello-voice-headless/test/performance/runs/twilio-carrier-call-<ts>/baseline.json`

**Passing proves (emulator):** Carrier WebSocket framing, PCMU encode/decode, mark/clear lifecycle,
delayed-startup buffering, sequence-gap metrics, overflow teardown with recorder truncation.

**Passing proves (live adapter):** Real Deepgram/Gemini/Cartesia through a Twilio-shaped socket, jitter-tolerant
inbound media, decoded carrier WAV, local Whisper confirms non-empty voice-in and voice-out.

**Passing proves (carrier call):** Twilio account accepted the call-control command and reached `completed` status
with non-zero duration. Does NOT prove WebSocket media timing — inspect review server logs and recorder artifacts
separately.

---

### 2.5 Telnyx

**Provider contract:** Call Control `POST /v2/calls` with `stream_bidirectional_mode: rtp`,
`stream_establish_before_call_originate: true`, `send_silence_when_idle: true`. Inbound: PCMU/8 kHz or
L16/16 kHz. `sequence_number` is observability only (Telnyx does not guarantee WebSocket event order);
inbound `media.chunk` uses a 4-frame bounded reorder window. Outbound: paced `media`, `mark`, `clear`.

**Official docs:**
- Telnyx Media Streaming: https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
  *(in `VOICE-ENGINE-HARDENING.md` Sources)*
- Telnyx Call Control Dial: https://developers.telnyx.com/api-reference/call-commands/dial
  *(from `TELEPHONY-VOICE-HANDOFF.md` only — NOT in `VOICE-ENGINE-HARDENING.md` Sources)*

**Emulator smoke:**

```bash
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telnyx-emulator
```

Artifact: `examples/02-hello-voice-headless/test/performance/runs/telnyx-emulator-<ts>/manifest.json`

Latest result: 7 inbound frames / 1,120 PCMU wire bytes / 4,480 normalized PCM bytes, 12 paced outbound PCMU
frames, quality gate passed.

**Live-provider adapter smoke:**

```bash
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=telnyx pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telephony-university-live
```

Artifact: `examples/02-hello-voice-headless/test/performance/runs/telephony-university-live-telnyx-<ts>/baseline.json`

**Real Telnyx carrier call (needs account credentials):**

```bash
TELNYX_API_KEY=... \
TELNYX_CONNECTION_ID=... \
TELNYX_FROM_NUMBER=+15551234567 \
TELNYX_TO_NUMBER=+15557654321 \
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telnyx-carrier-call
```

Artifact: `examples/02-hello-voice-headless/test/performance/runs/telnyx-carrier-call-<ts>/baseline.json`

**Passing proves (emulator):** Telnyx WebSocket framing, PCMU/L16 decode, out-of-order chunk reordering,
sequence-observability metrics, forced reorder drain on `stop`/disconnect.

**Passing proves (carrier call):** Telnyx accepted the real Call Control command and streaming contract; use
review server logs and recorder artifacts to prove media timing.

---

### 2.6 SmartPBX

**Provider contract:** `/media-stream` WebSocket; JSON events: `start`, `media`, `dtmf`, `hangup`.
Supports `g711_ulaw`/8 kHz, little-endian `pcm16`/24 kHz, and `opus`/48 kHz. Outbound `media` frames
carry `callId` and `accountId`. No `mark` or `clear` events are defined in the provider contract.
Barge-in discards local queued playout and emits internal `smartpbx.playout_drained`; no undocumented
carrier-side clear command is sent.

**Official docs:** Supplied project document (`ChanakaDev-ai-provider-example-websocket`, version 2026.01.23) —
no public URL. **UNVERIFIED** for any public SmartPBX AI Provider documentation URL.

**Emulator smoke:**

```bash
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:smartpbx-emulator
```

Artifact: `examples/02-hello-voice-headless/test/performance/runs/smartpbx-emulator-g711_ulaw-<ts>/manifest.json`

Latest result: `g711_ulaw`/8 kHz, 7 inbound frames / 1,120 PCMU wire bytes / 4,480 normalized PCM bytes,
12 paced outbound PCMU frames, `smartpbx.playout_drained` before hangup, quality gate passed.

**Live-provider adapter smoke:**

```bash
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=smartpbx pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telephony-university-live
```

Artifact: `examples/02-hello-voice-headless/test/performance/runs/telephony-university-live-smartpbx-<ts>/baseline.json`

**Real SmartPBX carrier call:** No `smoke:smartpbx-carrier-call` script exists in `package.json` or
`scripts/` as of `2026-05-30`. **UNVERIFIED** — confirm against `examples/02-hello-voice-headless/scripts/`
if a script has been added since. Provider-account validation requires the SmartPBX vendor to configure the
AI Provider URL (`wss://your-host/media-stream`) in their dashboard.

**Passing proves (emulator):** All three codec paths (`g711_ulaw`, `pcm16`/24 kHz, `opus`/48 kHz — codec
coverage is in package tests), startup-buffering, hangup/disconnect teardown with recorder truncation, and
that no undocumented carrier-side clear event is emitted.

---

## 3. Test Ladder (Cheapest → Most Production-Faithful)

### Rung 1 — Package tests (no network, no credentials)

```bash
pnpm -r typecheck
pnpm -r test
```

**What it proves:** TypeScript types compile; provider adapter logic (Deepgram, Cartesia, Telnyx, Twilio,
SmartPBX, core engine) runs against mock/in-process sockets; 109 WebSocket package tests cover envelope
validation, sequence/chunk invariants, session lifecycle, overflow teardown, interrupted-context suppression,
Telnyx reorder window, mark/clear semantics, and recorder truncation under blocked dispatch.

**What it does NOT prove:** Live provider connectivity, real codec timing, transcript quality, public TLS routing.

---

### Rung 2 — Deterministic emulator smokes (no live providers, no credentials)

```bash
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:twilio-emulator
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telnyx-emulator
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:smartpbx-emulator
```

Artifacts: `test/performance/runs/{twilio,telnyx,smartpbx}-emulator-<ts>/manifest.json`

Supports `SYRINX_EMULATED_NETWORK_PROFILE=clean|jittery|bursty` to simulate carrier jitter.

**What it proves:** Provider-shaped WebSocket framing end-to-end (PCMU encode/decode, mark/clear lifecycle,
sequence-gap metrics, overflow teardown, recorder truncation), schema-v2 manifest with separate wire-byte
and decoded-PCM-byte fields.

**What it does NOT prove:** Live STT/LLM/TTS processing, real media timing, transcript, Cartesia audio.

---

### Rung 3 — Browser runtime capture smoke (Chrome, no live STT/LLM/TTS)

```bash
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:browser-runtime
```

Artifact: `test/performance/runs/browser-runtime-<ts>/baseline.json`

**What it proves:** Headless Chrome `getUserMedia` + `AudioContext` at 48 kHz downsampled to 16 kHz PCM16;
all frames sent as `syrinx.audio.v1` binary envelopes with matching server-received frame count; server
decodes and returns an enveloped assistant-audio frame; browser decodes it, schedules playback, observes
`audio_clear`, and continuous listening opens the next context.

**What it does NOT prove:** Real microphone speech, live STT/LLM/TTS, anything beyond a single synthetic
audio frame from the server.

---

### Rung 4 — Live websocket smokes (real providers, local harness)

```bash
# 3-turn interactive: Deepgram nova-3 / Gemini agent / Cartesia TTS
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-interactive

# 24-turn longform: Deepgram nova-3 / Gemini agent / Gemini TTS
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-university
```

Artifacts:
- `test/performance/runs/websocket-university-interactive-<ts>/manifest.json`
- `test/performance/runs/websocket-university-<ts>/manifest.json`

Prerequisites: `DEEPGRAM_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `CARTESIA_API_KEY` + `CARTESIA_VOICE_ID`
(interactive) or just `GOOGLE_GENERATIVE_AI_API_KEY` + `DEEPGRAM_API_KEY` (longform with Gemini TTS).

**What it proves:** All three live providers (Deepgram, Gemini, Cartesia/Gemini TTS) run end-to-end through
the v2 engine over a local WebSocket; Smart Turn + Deepgram `Finalize` handshake; stage latencies measured
separately (STT final after speech end, LLM TTFT, first TTS audio after agent text); interrupted-context
suppression; VAD boundary events; `syrinx.audio.v1` envelope transport.

**What it does NOT prove:** Telephony codec (PCMU/μ-law/Opus), carrier WebSocket framing, public TLS,
recorder WAV export and Whisper coherence.

---

### Rung 5 — Live recorder coherence smoke (real providers + local Whisper audit)

```bash
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:live-recorder-coherence
```

Artifacts:
- `test/performance/runs/live-university-recorder-<ts>/baseline.json`
- `test/performance/runs/live-university-recorder-<ts>/recorder/<session>/manifest.json`
- `test/performance/runs/live-university-recorder-<ts>/turn-recordings/`

Requires: `DEEPGRAM_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `CARTESIA_API_KEY` + `CARTESIA_VOICE_ID`,
local `whisper` CLI (`whisper --model tiny.en`).

**What it proves:** Recorder writes user and assistant PCM/WAV with correct sample rates (Cartesia 16 kHz /
Gemini 24 kHz); manifest is validated before artifact export; per-turn WAVs are produced; local Whisper
confirms non-empty, coherent transcripts of recorded user and assistant audio as an independent audit;
provider STT text and spoken TTS text are preserved separately; zero truncations under normal flow.

**What it does NOT prove:** Telephony path, carrier framing, public TLS.

---

### Rung 6 — Live-provider telephony adapter smokes (real STT/LLM/TTS, emulated carrier)

```bash
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=twilio pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telephony-university-live

SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=telnyx pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telephony-university-live

SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=smartpbx pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telephony-university-live
```

Also supported: `SYRINX_TELEPHONY_NETWORK_PROFILE=bursty` for burst-packet simulation.

Artifacts per run:
- `test/performance/runs/telephony-university-live-<provider>-<ts>/baseline.json`
- `carrier-inbound.wav` / `carrier-outbound.wav`
- `whisper/carrier-inbound/carrier-inbound.json` / `whisper/carrier-outbound/carrier-outbound.json`
- `recorder/<provider>/manifest.json`

Prerequisites: `DEEPGRAM_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `CARTESIA_API_KEY` + `CARTESIA_VOICE_ID`,
local `whisper` CLI.

**What it proves:** Real Deepgram/Gemini/Cartesia through a provider-shaped carrier socket; PCMU encode/decode;
paced outbound carrier playout; Twilio/Telnyx terminal mark before graceful teardown; SmartPBX
`smartpbx.playout_drained` metric before hangup; decoded carrier WAVs at 8 kHz; local Whisper confirms
non-empty voice-in and voice-out transcripts; recorder manifest with zero assistant truncations.

**What it does NOT prove:** Public TLS, real carrier signaling, account-level webhook timing or dashboard setup.

Latest passing baselines (from `HANDOFF.md`):

| Provider | Network | First carrier outbound after last inbound | Quality gate |
|---|---|---:|---|
| Twilio | jittery | 202 ms | Passed |
| Telnyx | jittery | 624 ms | Passed |
| SmartPBX | jittery | 1,381 ms | Passed |

---

### Rung 7 — Fly synthetic carrier spike (public TLS, two-host, real everything)

This is the accepted production-replication run when real carrier accounts are unavailable.

```bash
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:fly-synthetic-carrier
```

Optional controls:

```bash
SYRINX_FLY_REGION=sin          # Fly region (default: sin)
SYRINX_FLY_MEMORY_MB=1024      # Machine memory (default: 1024)
SYRINX_FLY_SYNTHETIC_PROVIDERS=twilio,telnyx,smartpbx
SYRINX_FLY_APP_SUFFIX=my-suffix
```

**What the command does:**
1. Creates two disposable Fly apps (`syrinx-bot-spike-<suffix>` and `syrinx-carrier-spike-<suffix>`).
2. Stages live provider secrets (`DEEPGRAM_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `CARTESIA_API_KEY`,
   `CARTESIA_VOICE_ID`) into the bot app.
3. Deploys both with `--ha=false` on `shared-cpu-1x` 1024 MB machines (auto-stop enabled).
4. Runs Twilio, Telnyx, and SmartPBX synthetic calls from the carrier app to the bot app over public TLS.
5. Downloads all artifacts locally.
6. Validates bot recorder manifests, `events.jsonl` envelopes, WAV headers, and carrier-boundary WAVs.
7. Destroys both Fly apps in a `finally` block.

**Artifacts written:**

```
test/performance/runs/fly-synthetic-carrier-<ts>/summary.json
test/performance/runs/fly-synthetic-carrier-<ts>/bot-artifacts/<provider>/<session>/events.jsonl
test/performance/runs/fly-synthetic-carrier-<ts>/bot-artifacts/<provider>/<session>/manifest.json
test/performance/runs/fly-synthetic-carrier-<ts>/bot-artifacts/<provider>/<session>/user_audio.wav
test/performance/runs/fly-synthetic-carrier-<ts>/bot-artifacts/<provider>/<session>/assistant_audio.wav
test/performance/runs/fly-synthetic-carrier-<ts>/carrier-artifacts/<provider>/call-result.json
test/performance/runs/fly-synthetic-carrier-<ts>/carrier-artifacts/<provider>/carrier-inbound.wav
test/performance/runs/fly-synthetic-carrier-<ts>/carrier-artifacts/<provider>/carrier-outbound.wav
```

Bot WAVs: RIFF PCM, 16-bit, mono, 16 kHz. Carrier-boundary WAVs: RIFF PCM, 16-bit, mono, 8 kHz.

**What it proves:** Public TLS WebSocket routing; provider-shaped carrier media delivery across two network
hops; live Deepgram/Gemini/Cartesia on the bot; recorder output with PCM/WAV and `events.jsonl`; carrier
boundary receives paced assistant audio back; both Fly machines destroyed after artifact download.

**What it does NOT prove:** Real carrier account signaling, Twilio/Telnyx/SmartPBX dashboard call-control,
account-specific webhook timing or SIP/RTP layer behavior.

Latest result (`2026-05-29`, `sin`, `shared-cpu-1x:1024MB`):

| Provider | Network | Inbound frames | Outbound frames | Completion evidence | Quality gate |
|---|---|---:|---:|---|---|
| Twilio | jittery | 1,263 | 537 | `outboundEndMarks: 1` | Passed |
| Telnyx | jittery | 1,263 | 575 | `outboundEndMarks: 1` | Passed |
| SmartPBX | jittery | 1,263 | 485 | `outboundQuietDrains: 1` | Passed |

---

### Rung 8 — Real carrier account validation (requires account credentials)

**Prerequisites:** Public TLS host with the telephony review server running (or a Fly-deployed bot).
Start the bot server first:

```bash
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless review:telephony
```

Run public routing preflight before wiring a carrier dashboard:

```bash
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless probe:telephony-public https://your-public-tls-host.example
```

**Twilio carrier call:**

```bash
TWILIO_ACCOUNT_SID=AC... \
TWILIO_AUTH_TOKEN=... \
TWILIO_FROM_NUMBER=+15551234567 \
TWILIO_TO_NUMBER=+15557654321 \
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:twilio-carrier-call
```

Artifact: `test/performance/runs/twilio-carrier-call-<ts>/baseline.json`

**Telnyx carrier call:**

```bash
TELNYX_API_KEY=... \
TELNYX_CONNECTION_ID=... \
TELNYX_FROM_NUMBER=+15551234567 \
TELNYX_TO_NUMBER=+15557654321 \
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:telnyx-carrier-call
```

Artifact: `test/performance/runs/telnyx-carrier-call-<ts>/baseline.json`

**SmartPBX carrier call:** No `smoke:smartpbx-carrier-call` script exists in `package.json` as of
`2026-05-30`. **UNVERIFIED** — provider-account validation for SmartPBX requires configuring the AI
Provider URL (`wss://your-host/media-stream`) in the SmartPBX dashboard directly. Confirm whether a
script has been added against `examples/02-hello-voice-headless/scripts/`.

**What it proves (Twilio/Telnyx):** Carrier account accepted the real call-control command; call reached a
connected leg and completed with non-zero duration (Twilio `completed` status; Telnyx accepts `POST /v2/calls`
with streaming fields). Use review server logs and recorder artifacts from rung 5/6 to prove media timing,
transcript, TTS, and marks — the carrier-call smokes prove account setup, not WebSocket media quality.

**What it does NOT prove:** WebSocket media stream timing or transcript quality (inspect recorder artifacts
and server logs separately).

---

## 4. Ladder Summary

| Rung | Command(s) | Credentials needed | Proves |
|---|---|---|---|
| 1 — Package tests | `pnpm -r typecheck && pnpm -r test` | None | Type safety, adapter logic, envelope invariants |
| 2 — Emulator smokes | `smoke:twilio-emulator` / `smoke:telnyx-emulator` / `smoke:smartpbx-emulator` | None | Carrier framing, PCMU codec, mark/clear, overflow teardown |
| 3 — Browser runtime | `smoke:browser-runtime` | None | Chrome audio capture, `syrinx.audio.v1` round-trip |
| 4 — Live websocket | `smoke:websocket-interactive` / `smoke:websocket-university` | Deepgram + Gemini + Cartesia | Live STT/LLM/TTS end-to-end, stage latencies |
| 5 — Recorder coherence | `smoke:live-recorder-coherence` | Deepgram + Gemini + Cartesia + `whisper` CLI | Recorder WAV export, Whisper audit, sample-rate metadata |
| 6 — Live telephony adapter | `smoke:telephony-university-live` (per provider) | Deepgram + Gemini + Cartesia + `whisper` CLI | PCMU codec + live providers + carrier WAV + Whisper |
| 7 — Fly synthetic carrier | `smoke:fly-synthetic-carrier` | Above + `flyctl` + Docker | Public TLS, two-host carrier-to-bot, recorder artifacts, teardown |
| 8 — Real carrier accounts | `smoke:twilio-carrier-call` / `smoke:telnyx-carrier-call` | Account creds + public TLS host | Carrier call-control acceptance, account setup |

**The accepted production-replication floor is rung 7.** Rung 8 is provider-account validation, not a
blocker for the core transport hardening.
