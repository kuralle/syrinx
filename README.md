# Syrinx

> Open voice orchestration and media-transport layer for [Kuralle](https://github.com/kuralle).

Syrinx is the self-hostable voice engine behind Kuralle, the open alternative to
closed "voice agent API" platforms. It keeps provider and client quirks at the
transport edge and hands the agent runtime a clean stream of mono PCM16 audio.

## What it provides

- Resumable WebSocket audio protocol (mono PCM16, turn and session management,
  sequence and sample-rate locks, reconnect within a retention window).
- Telephony adapters: SIP, Twilio, LiveKit.
- A provider-testing suite for realtime audio backends.

## Configuration

Syrinx reads provider credentials from the environment. Copy your keys into a
local `.env` (which is gitignored and never committed):

```
OPENAI_API_KEY=
GEMINI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
DEEPGRAM_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
CARTESIA_API_KEY=
CARTESIA_VOICE_ID=
```

See `docs/websocket-audio-protocol.md` for the wire protocol and
`PROVIDER-TESTING.md` for the provider test matrix.

## License

MIT
