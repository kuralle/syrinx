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
- `POST /telnyx/webhook`
- `WS /twilio`
- `WS /telnyx`
- `WS /media-stream`

`GET /healthz` reports the telephony engine output rate separately from the recorder assistant source rate. Carrier output remains 16 kHz engine PCM before provider encoding, while recorder assistant PCM follows the selected TTS provider (`16 kHz` Cartesia, `24 kHz` Gemini).

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

To place a real outbound Twilio carrier call through the same TwiML endpoint:

```bash
TWILIO_ACCOUNT_SID=AC... \
TWILIO_AUTH_TOKEN=... \
TWILIO_FROM_NUMBER=+15551234567 \
TWILIO_TO_NUMBER=+15557654321 \
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:twilio-carrier-call
```

Optional controls:

```bash
SYRINX_TWILIO_RING_TIMEOUT_SECONDS=20
SYRINX_TWILIO_TIME_LIMIT_SECONDS=120
SYRINX_TWILIO_POLL_TIMEOUT_MS=180000
SYRINX_TWILIO_COMPLETE_ON_POLL_TIMEOUT=true
SYRINX_TWILIO_TWIML_URL=https://your-public-tls-host.example/twilio/twiml
SYRINX_TWILIO_STATUS_CALLBACK_URL=https://your-public-tls-host.example/twilio/status
```

The script calls Twilio's REST API, points the call at `/twilio/twiml`, polls the Call resource until a terminal status, writes `test/performance/runs/twilio-carrier-call-*/baseline.json`, and fails unless Twilio reports final status `completed` with non-zero duration. If polling times out, it completes the call by default to avoid leaving a paid call running. This proves Twilio carrier call setup reached a connected leg; the review server logs and recorder artifacts still need to be inspected to prove media websocket timing, transcript, TTS, marks, and interruption behavior.

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
  "stream_bidirectional_codec": "PCMU",
  "webhook_url": "https://your-public-tls-host.example/telnyx/webhook",
  "webhook_url_method": "POST"
}
```

Set `SYRINX_TELNYX_BIDIRECTIONAL_CODEC=L16` only when the Telnyx call stream is also configured for L16.

To place a real outbound Telnyx carrier call with bidirectional RTP media streaming enabled at dial time:

```bash
TELNYX_API_KEY=... \
TELNYX_CONNECTION_ID=... \
TELNYX_FROM_NUMBER=+15551234567 \
TELNYX_TO_NUMBER=+15557654321 \
SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://your-public-tls-host.example \
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:telnyx-carrier-call
```

Optional controls:

```bash
SYRINX_TELNYX_BIDIRECTIONAL_CODEC=PCMU
SYRINX_TELNYX_RING_TIMEOUT_SECONDS=20
SYRINX_TELNYX_TIME_LIMIT_SECONDS=120
SYRINX_TELNYX_DWELL_MS=45000
SYRINX_TELNYX_HANGUP_AFTER_DWELL=true
SYRINX_TELNYX_STREAM_URL=wss://your-public-tls-host.example/telnyx
SYRINX_TELNYX_WEBHOOK_URL=https://your-public-tls-host.example/telnyx/webhook
```

The script calls Telnyx `POST /v2/calls` with `stream_url`, `stream_track: both_tracks`, `stream_bidirectional_mode: rtp`, `stream_bidirectional_codec`, `stream_establish_before_call_originate: true`, and `send_silence_when_idle: true`. It writes `test/performance/runs/telnyx-carrier-call-*/baseline.json` and sends a Telnyx hangup command after the dwell window by default. This proves Telnyx accepted a real carrier call command with the intended streaming contract; the review server logs and recorder artifacts still need to prove media websocket timing, transcript, TTS, marks, and interruption behavior.

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

You can also run the provider-shaped public probe against either a local server or a public TLS host:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless probe:telephony-public http://127.0.0.1:4181
pnpm --filter @asyncdot-example/02-hello-voice-headless probe:telephony-public https://your-public-tls-host.example
```

The probe validates `/healthz`, `/telephony/config.json`, `/twilio/twiml`, `POST /twilio/status`, `POST /telnyx/webhook`, opens Twilio/Telnyx/SmartPBX-shaped websocket sessions, sends one valid PCMU media frame plus the provider's terminal event, and fails if websocket compression is negotiated. Passing this probe proves public routing, callback routing, and websocket upgrade shape, not a real carrier call.

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

After deployment, run:

```bash
pnpm --filter @asyncdot-example/02-hello-voice-headless probe:telephony-public https://your-fly-app.fly.dev
```

Destroy the Fly app/machine after this probe and any carrier sandbox call you intentionally run.

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

## Synthetic Carrier-To-Bot Spike

When real Twilio, Telnyx, or SmartPBX carrier accounts are unavailable, run two hosts:

- Bot host: `review:telephony`, serving the real university-support agent and recorder.
- Carrier host: `review:synthetic-carrier`, acting as the public carrier. It fetches the bot's `/telephony/config.json`, opens the provider-shaped websocket, sends the university fixture as PCMU/8 kHz phone media with optional jitter, captures assistant media back from the bot, and writes carrier-boundary WAV evidence.

Local run:

```bash
SYRINX_TELEPHONY_REVIEW_HOST=127.0.0.1 \
SYRINX_TELEPHONY_REVIEW_PORT=4185 \
SYRINX_TELEPHONY_PUBLIC_BASE_URL=http://127.0.0.1:4185 \
SYRINX_REVIEW_TTS=cartesia \
pnpm --filter @asyncdot-example/02-hello-voice-headless review:telephony

SYRINX_SYNTHETIC_CARRIER_HOST=127.0.0.1 \
SYRINX_SYNTHETIC_CARRIER_PORT=4191 \
pnpm --filter @asyncdot-example/02-hello-voice-headless review:synthetic-carrier
```

Then run each provider shape:

```bash
curl -sS -X POST http://127.0.0.1:4191/calls/university \
  -H 'content-type: application/json' \
  --data '{"provider":"twilio","botBaseUrl":"http://127.0.0.1:4185","networkProfile":"jittery"}'

curl -sS -X POST http://127.0.0.1:4191/calls/university \
  -H 'content-type: application/json' \
  --data '{"provider":"telnyx","botBaseUrl":"http://127.0.0.1:4185","networkProfile":"jittery"}'

curl -sS -X POST http://127.0.0.1:4191/calls/university \
  -H 'content-type: application/json' \
  --data '{"provider":"smartpbx","botBaseUrl":"http://127.0.0.1:4185","networkProfile":"jittery"}'
```

Recorder artifacts are available from the bot:

```bash
curl http://127.0.0.1:4185/telephony/artifacts.json
curl -o user.wav http://127.0.0.1:4185/telephony/artifacts/<session>/user_audio.wav
curl -o assistant.wav http://127.0.0.1:4185/telephony/artifacts/<session>/assistant_audio.wav
curl -o events.jsonl http://127.0.0.1:4185/telephony/artifacts/<session>/events.jsonl
```

The artifact index includes `events.jsonl`, `manifest.json`, `user_audio.pcm`, `assistant_audio.pcm`, and generated `user_audio.wav` / `assistant_audio.wav` for listening or Whisper transcription. The WAV endpoints are test-server conveniences over recorder PCM; `assistant_audio.wav` is generated from the recorder manifest sample rate, so Cartesia and Gemini recordings keep their true output rates. Do not expose this artifact API in production.

Disposable Fly two-host run, preferred:

```bash
SYRINX_TELEPHONY_NETWORK_PROFILE=jittery \
pnpm --filter @asyncdot-example/02-hello-voice-headless smoke:fly-synthetic-carrier
```

The command creates two disposable Fly apps with generated names:

- Bot app: `review:telephony`, one `shared-cpu-1x` 1024MB machine, auto-stop enabled.
- Carrier app: `review:synthetic-carrier`, one `shared-cpu-1x` 1024MB machine, auto-stop enabled.

It stages live provider secrets from `.env` into the bot app, deploys both apps with `--ha=false`, runs Twilio, Telnyx, and SmartPBX shaped calls by default, downloads evidence locally, then destroys both Fly apps in a `finally` block. The summary is written under:

```text
examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-*/summary.json
```

Downloaded evidence is grouped by provider:

```text
examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-*/bot-artifacts/<provider>/<session>/events.jsonl
examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-*/bot-artifacts/<provider>/<session>/manifest.json
examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-*/bot-artifacts/<provider>/<session>/user_audio.wav
examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-*/bot-artifacts/<provider>/<session>/assistant_audio.wav
examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-*/carrier-artifacts/<provider>/call-result.json
examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-*/carrier-artifacts/<provider>/carrier-inbound.wav
examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-*/carrier-artifacts/<provider>/carrier-outbound.wav
```

The bot WAV files are the recorder tracks to inspect with a player or local Whisper. They are stacked per session and separated by direction (`user_audio.wav` for caller audio, `assistant_audio.wav` for bot audio), not split per turn. `events.jsonl` is the recorder event stream for transcript, metric, recorder, and engine timing inspection.

Useful controls:

```bash
SYRINX_FLY_REGION=sin
SYRINX_FLY_MEMORY_MB=1024
SYRINX_TELEPHONY_NETWORK_PROFILE=clean|jittery|bursty
SYRINX_FLY_SYNTHETIC_PROVIDERS=twilio,telnyx,smartpbx
SYRINX_FLY_APP_SUFFIX=my-test-suffix
```

Manual disposable Fly two-host run:

```bash
fly config validate -c fly.bot-telephony-spike.toml
fly config validate -c fly.synthetic-carrier-spike.toml

fly apps create syrinx-bot-spike-mcj-20260529
fly apps create syrinx-carrier-spike-mcj-20260529

set -a; source .env; set +a
fly secrets set -c fly.bot-telephony-spike.toml \
  DEEPGRAM_API_KEY="$DEEPGRAM_API_KEY" \
  GOOGLE_GENERATIVE_AI_API_KEY="$GOOGLE_GENERATIVE_AI_API_KEY" \
  CARTESIA_API_KEY="$CARTESIA_API_KEY" \
  CARTESIA_VOICE_ID="$CARTESIA_VOICE_ID"

fly deploy -c fly.bot-telephony-spike.toml --ha=false
fly deploy -c fly.synthetic-carrier-spike.toml --ha=false
```

Run the synthetic carrier calls:

```bash
curl -sS --max-time 240 -X POST https://syrinx-carrier-spike-mcj-20260529.fly.dev/calls/university \
  -H 'content-type: application/json' \
  --data '{"provider":"twilio","networkProfile":"jittery"}'

curl -sS --max-time 240 -X POST https://syrinx-carrier-spike-mcj-20260529.fly.dev/calls/university \
  -H 'content-type: application/json' \
  --data '{"provider":"telnyx","networkProfile":"jittery"}'

curl -sS --max-time 240 -X POST https://syrinx-carrier-spike-mcj-20260529.fly.dev/calls/university \
  -H 'content-type: application/json' \
  --data '{"provider":"smartpbx","networkProfile":"jittery"}'
```

Download bot artifacts before teardown:

```bash
OUT=examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-bot-artifacts-$(date -u +%Y-%m-%dT%H-%MZ)
mkdir -p "$OUT"
curl -sS https://syrinx-bot-spike-mcj-20260529.fly.dev/telephony/artifacts.json -o "$OUT/artifacts.json"
jq -r '.artifacts[] | [.path,.url] | @tsv' "$OUT/artifacts.json" | while IFS=$'\t' read -r path url; do
  mkdir -p "$OUT/$(dirname "$path")"
  curl -sS "https://syrinx-bot-spike-mcj-20260529.fly.dev${url}" -o "$OUT/$path"
done
```

Always destroy both spike apps after downloading artifacts:

```bash
fly apps destroy syrinx-carrier-spike-mcj-20260529 --yes
fly apps destroy syrinx-bot-spike-mcj-20260529 --yes
```

Latest synthetic carrier spike, `2026-05-29`, used `smoke:fly-synthetic-carrier` with two one-machine Fly apps in `sin`, both `shared-cpu-1x:1024MB`, both auto-stopping. The command downloaded artifacts and destroyed both apps before exit. Results:

| Provider | Network | Inbound frames | Outbound frames | Completion evidence | Quality gate |
|---|---|---:|---:|---|---|
| Twilio | jittery | 1,263 | 537 | `outboundEndMarks: 1` | Passed |
| Telnyx | jittery | 1,263 | 575 | `outboundEndMarks: 1` | Passed |
| SmartPBX | jittery | 1,263 | 485 | `outboundQuietDrains: 1` | Passed |

Downloaded bot recorder artifacts and carrier-boundary artifacts are under `examples/02-hello-voice-headless/test/performance/runs/fly-synthetic-carrier-2026-05-29T03-42-37-213Z/`. Each provider session contains `events.jsonl`, `manifest.json`, `user_audio.wav`, and `assistant_audio.wav`; all bot WAVs validated as RIFF PCM, 16-bit, mono, 16 kHz. Each provider also has `carrier-inbound.wav` and `carrier-outbound.wav`; those carrier-boundary WAVs validated as RIFF PCM, 16-bit, mono, 8 kHz. `fly apps list` showed no remaining spike apps after the run.

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
