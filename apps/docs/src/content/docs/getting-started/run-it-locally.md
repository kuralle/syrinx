---
title: Run it locally
description: Drive a Syrinx agent on your own machine — from a WAV fixture with no server, or from your browser with a real microphone.
---

The [Quickstart](/getting-started/quickstart/) agent is complete but idle: `start()` initializes the plugins, and then nothing happens until something pushes audio frames at the session. In production that something is a browser socket or a phone call. On your laptop it can be a WAV file — which is the fastest way to watch a whole turn happen.

Two local paths, in order of setup cost.

:::note[This one needs the repo]
Everything else in these docs works from `npm install`. The runnable examples live in the Syrinx repository, so this page assumes you have it cloned:

```bash
git clone https://github.com/kuralle/syrinx.git
cd syrinx && pnpm install
```

Put your provider keys in a `.env` at the repo root — the examples load it automatically.
:::

## 1. A WAV file — no mic, no server

The fastest full turn. [`hello-voice-agent.ts`](https://github.com/kuralle/syrinx/blob/main/examples/02-hello-voice-headless/src/hello-voice-agent.ts) is the Quickstart agent verbatim, plus a `main()` that pushes a fixture WAV in 20 ms frames the way a transport would:

```bash
pnpm -C examples/02-hello-voice-headless exec tsx src/hello-voice-agent.ts
```

```
Feeding 3.2s of audio…

You said:   What's the application deadline for the computer science masters?
Agent said: Please specify the university so I can provide the exact deadline for the computer science master's application.
Spoken:     172100 bytes of TTS audio
```

That is the entire cascade end to end — Deepgram heard the fixture, the reasoner answered, Cartesia spoke it. Needs `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, and `CARTESIA_API_KEY`; it names any that are missing and exits.

The two things worth noticing in that file, because they are the two things that trip people up:

- **`await session.start()`** — until it resolves, no plugin is initialized and the bus is not draining, so pushed audio goes nowhere.
- **The trailing silence.** After the speech frames, the script feeds 1.5 s of silence. Endpointing reads the *gap*, so without it the turn never closes and the agent never answers.

The [talking–thinking agent](/guides/talking-thinking/) runs the same way and needs only `OPENAI_API_KEY`:

```bash
pnpm -C examples/02-hello-voice-headless exec tsx src/talking-thinking.ts
```

## 2. Your browser and a real microphone

To actually talk to an agent out loud, run the review studio — a local HTTP + WebSocket server that serves a mic-capture page and drives a live session behind it:

```bash
pnpm -C examples/02-hello-voice-headless review:studio
```

```
Syrinx university review studio: http://127.0.0.1:4173
WebSocket endpoint: ws://127.0.0.1:4173/ws
TTS provider: cartesia; input PCM: 16000 Hz mono s16le
```

Open <http://127.0.0.1:4173>, allow microphone access, and speak. The server owns turn detection, so you talk and stop naturally — there is no push-to-talk. Barge-in works: start talking while the agent is speaking and it yields.

:::caution[It runs the bundled demo agent, not yours]
`review:studio` drives a **fixed** agent — the university-support demo in `src/university-support-agent.ts`. There is currently no flag to point it at the agent you built; the environment variables below tune the server, not the agent. To hear *your* agent over a microphone today, copy `scripts/serve-websocket-review-studio.ts` and swap the session factory on the line that calls `createUniversitySupportSession`. Closing that gap properly is on the roadmap.
:::

For a richer client than the built-in page — transcript panel, backend switching, connection controls — [`apps/studio`](https://github.com/kuralle/syrinx/tree/main/apps/studio) is a Vite/React front end that speaks the same protocol. Run `review:studio` as the backend, then `pnpm --filter @kuralle-syrinx/studio dev`, and point it at `ws://127.0.0.1:4173/ws`.

| Variable | Default | What it does |
| --- | --- | --- |
| `SYRINX_REVIEW_PORT` | `4173` | Port for the studio and its `/ws` endpoint |
| `SYRINX_REVIEW_HOST` | `127.0.0.1` | Bind address — loopback only unless you change it |
| `SYRINX_REVIEW_TTS` | `cartesia` if `CARTESIA_API_KEY` is set, else `gemini` | Which TTS speaks |
| `SYRINX_OBS_DIR` | `/tmp/syrinx-obs` | Where per-session turn-taking JSONL is written |

That last one is the useful one when something feels wrong: every session writes a JSONL file of how each turn actually resolved — speech boundaries, commits, barge-in, overlap, errors. It is the cheapest way to see *why* a turn ended when it did.

## When it doesn't work

- **No transcript.** The fixture path prints `(no transcript)` if STT never returned a final. Check `DEEPGRAM_API_KEY`, then that your audio is mono 16 kHz PCM16 — Syrinx does not resample for you on the fixture path.
- **Transcript but no reply.** The reasoner failed; the session emits a recoverable `llm.error` packet rather than throwing. Subscribe to it while debugging.
- **Reply but no audio.** A TTS key or voice id problem — `CARTESIA_VOICE_ID` is required alongside the key.
- **The turn never ends.** Not enough trailing silence, or an endpointing owner that never fires. See [`endpointingOwner`](/guides/building-a-voice-agent/).

## Next

- [Testing an agent](/reference/testing/) — turn this local run into a deterministic check you can put in CI.
- [Deploy on Cloudflare](/guides/deploy-on-cloudflare/) — the same session on the edge.
