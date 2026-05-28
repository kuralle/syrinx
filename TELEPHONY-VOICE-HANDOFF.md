# Telephony Voice Handoff

This guide is for live/sandbox phone-to-agent review over carrier websockets.

## Start The Server

From `syrinx`:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless review:telephony
```

Useful environment:

```bash
SYRINX_TELEPHONY_REVIEW_PORT=4180
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example
SYRINX_REVIEW_TTS=cartesia
SYRINX_TELNYX_BIDIRECTIONAL_CODEC=PCMU
```

The server exposes:

- `GET /healthz`
- `GET /telephony/config.json`
- `GET /twilio/twiml`
- `POST /twilio/status`
- `WS /twilio`
- `WS /telnyx`
- `WS /media-stream`

Carrier calls require a public TLS endpoint because carrier media streams connect with `wss://`. Use a stable tunnel or deployed host, set `SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://...`, then restart the server.

## Twilio

Point a Twilio Voice webhook or TwiML Bin to:

```text
https://your-public-tls-host.example/twilio/twiml
```

That endpoint returns bidirectional `<Connect><Stream>` TwiML targeting:

```text
wss://your-public-tls-host.example/twilio
```

Expected Twilio media contract:

- Inbound: Twilio PCMU / 8 kHz / mono media frames.
- Outbound: paced 20 ms PCMU media frames.
- Interruption: adapter locally clears pending playout and sends Twilio `clear`.
- Playback evidence: adapter sends Twilio `mark` only after paced playout drains.

## Telnyx

Fetch:

```bash
curl https://your-public-tls-host.example/telephony/config.json
```

Use the `telnyx.callFields` object when creating or streaming a Telnyx call:

```json
{
  "stream_url": "wss://your-public-tls-host.example/telnyx",
  "stream_track": "both_tracks",
  "stream_bidirectional_mode": "rtp",
  "stream_bidirectional_codec": "PCMU"
}
```

Set `SYRINX_TELNYX_BIDIRECTIONAL_CODEC=L16` only when the Telnyx call stream is also configured for L16.

## SmartPBX

Configure the SmartPBX AI Provider websocket URL as:

```text
wss://your-public-tls-host.example/media-stream
```

Supported SmartPBX media formats:

- `g711_ulaw` / 8 kHz
- `pcm16` / 24 kHz little-endian
- `opus` / 48 kHz

SmartPBX documentation provided for this project does not define a playback `clear` event. The adapter clears local queued playout and recorder evidence on barge-in, but live testing still needs to confirm whether SmartPBX has a supported carrier-side playback clear command.

## What To Verify

For every live/sandbox call, capture:

- Provider connection reaches the expected websocket path.
- `start` arrives before or with first media and validates the expected codec/sample rate.
- Inbound media produces final Deepgram transcript after Smart Turn finalization.
- Agent text reaches TTS, and first assistant media is sent back over the carrier websocket.
- Twilio/Telnyx mark/clear behavior works as documented.
- SmartPBX interruption behavior is observed without inventing undocumented commands.
- Recorder artifacts are written under the printed recorder directory.
- Compare live first outbound media timing with emulator `firstOutboundMediaAfterLastInbound` and `maxInboundMediaGap`.

## Local Preflight

Without a public tunnel, this only proves the server and HTTP configuration endpoints:

```bash
SYRINX_TELEPHONY_REVIEW_HOST=127.0.0.1 \
SYRINX_TELEPHONY_REVIEW_PORT=4181 \
pnpm --filter @asyncdot-example/02-hello-voice-headless review:telephony
```

Then:

```bash
curl http://127.0.0.1:4181/healthz
curl http://127.0.0.1:4181/telephony/config.json
curl http://127.0.0.1:4181/twilio/twiml
```

Local `ws://` output is not sufficient for real carriers; use public `https://` so the generated websocket URLs are `wss://`.

## Disposable Fly Public-TLS Spike

Use Fly only as a disposable public websocket spike, not as production hosting. The checked-in spike config is `fly.telephony-spike.toml` and is intentionally constrained to one auto-stopping machine:

- `shared-cpu-1x`
- `memory_mb = 1024`
- `auto_stop_machines = "stop"`
- `auto_start_machines = true`
- `min_machines_running = 0`

Before deploying, verify the config:

```bash
fly config validate -c fly.telephony-spike.toml
```

Then create the app, set secrets from `.env`, deploy with `--ha=false`, run the public checks, and destroy the app/machine immediately after the spike. Do not create Fly Postgres for this review server.

Latest public-TLS spike, `2026-05-28`, used app `syrinx-telephony-spike-mcj-20260528` in `sin` on one `shared-cpu-1x:1024MB` machine. Results:

- `GET https://syrinx-telephony-spike-mcj-20260528.fly.dev/healthz` returned `ok: true`, `ttsProvider: cartesia`, 16 kHz input/output.
- `GET /telephony/config.json` returned `wss://` URLs for Twilio, Telnyx, and SmartPBX.
- `GET /twilio/twiml` returned bidirectional `<Connect><Stream>` TwiML.
- `wss://.../twilio` accepted a Twilio-shaped `connected`/`start`/PCMU `media`/`stop` session.
- `wss://.../telnyx` accepted a Telnyx-shaped PCMU `start`/`media`/`stop` session.
- `wss://.../media-stream` accepted a SmartPBX-shaped `g711_ulaw` `start`/`media`/`stop` session.
- All websocket probes reported `extensions: ""`, so no websocket compression was negotiated.
- The Fly app and machine were destroyed after the probe.

The spike exposed two deployment-only issues that are now fixed: multiple provider websocket adapters mounted on one HTTP server must use explicit `upgrade` routing instead of independent `server + path` listeners, and the container must install a single ONNX runtime version with HuggingFace's undeclared `onnxruntime-common` dependency made explicit in `pnpm-workspace.yaml`.

## Live-Provider Adapter Smoke

Before involving a carrier account, run the local adapter smoke with the live providers:

```bash
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=twilio pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=telnyx pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
SYRINX_TELEPHONY_PROVIDER=smartpbx pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telephony-university-live
```

This emulates the provider websocket shape locally but uses live Deepgram, Gemini, Cartesia, and the recorder. The smoke sends the university fixture over PCMU/8 kHz carrier frames, optionally applies `SYRINX_TELEPHONY_NETWORK_PROFILE=clean|jittery|bursty` to inbound speech media, waits for Deepgram/Pipecat finalization, verifies agent text and outbound carrier media, waits for paced carrier playout to drain before hangup, writes decoded carrier-boundary WAV files, runs local Whisper over both inbound and outbound carrier audio, and fails if the recorder manifest is missing, assistant audio was truncated, carrier PCM is empty, the requested non-clean profile did not create a measurable media gap, or either local Whisper transcript is empty. Twilio and Telnyx also require a terminal playback mark before graceful teardown; the adapters now keep that terminal mark pending until all prior playback marks have been acknowledged. SmartPBX has no documented playback mark, so its smoke requires the internal `smartpbx.playout_drained` metric emitted after the paced local queue reaches the `tts.end` tail.

Latest passing artifacts:

- Twilio jittery: `test/performance/runs/telephony-university-live-twilio-2026-05-28T12-41-24-007Z/baseline.json`
- Telnyx jittery: `test/performance/runs/telephony-university-live-telnyx-2026-05-28T12-42-20-134Z/baseline.json`
- SmartPBX jittery: `test/performance/runs/telephony-university-live-smartpbx-2026-05-28T12-43-17-181Z/baseline.json`
- Twilio bursty: `test/performance/runs/telephony-university-live-twilio-2026-05-28T13-06-09-819Z/baseline.json`
- Telnyx bursty: `test/performance/runs/telephony-university-live-telnyx-2026-05-28T13-07-03-890Z/baseline.json`
- SmartPBX bursty: `test/performance/runs/telephony-university-live-smartpbx-2026-05-28T13-14-12-207Z/baseline.json`

Each run writes:

- `carrier-inbound.wav` from the caller-side PCMU/g711 audio sent into the adapter.
- `carrier-outbound.wav` from the assistant media emitted back to the carrier websocket.
- `whisper/carrier-inbound/carrier-inbound.json`
- `whisper/carrier-outbound/carrier-outbound.json`
- `recorder/<provider>/manifest.json`

Passing this smoke does not prove carrier signaling, TLS, or real provider media timing. It proves the local carrier adapter plus live STT/LLM/TTS/recorder path before a real Twilio/Telnyx/SmartPBX call.
