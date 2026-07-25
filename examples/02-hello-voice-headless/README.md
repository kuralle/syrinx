# 02 — hello voice, headless

The example package the docs point at. "Headless" means every agent here is driven
by **audio frames pushed from code** — a WAV fixture, a synthetic carrier, or a
browser socket — so you can run a complete voice turn on your laptop without a
phone number or a deployed server.

It is also where the live proof for this repo lives: 60 npm scripts, most of them
smoke tests that exercise one provider, transport, or behaviour end to end against
real APIs.

## Setup

Keys go in a `.env` at the **repo root** (not here) — every script loads it via
`ensureRepoRootDotenv()`. The cascade scripts need `DEEPGRAM_API_KEY`,
`OPENAI_API_KEY`, and `CARTESIA_API_KEY` + `CARTESIA_VOICE_ID`; realtime scripts
need only `OPENAI_API_KEY`. Each script names the keys it is missing and exits.

## Start here

```bash
# One full cascade turn from a WAV fixture — transcript, reply, spoken audio.
pnpm exec tsx src/hello-voice-agent.ts

# The same, for the realtime front + background thinker (OPENAI_API_KEY only).
pnpm exec tsx src/talking-thinking.ts

# Talk to an agent from your browser: http://127.0.0.1:4173
pnpm review:studio
```

Those three are the whole "does this work on my machine" story. Everything below is
for a specific question.

## The files docs quote

| File | What it is |
| --- | --- |
| `src/hello-voice-agent.ts` | The Quickstart cascade agent. **Runnable** — has a `main()` that feeds it a fixture. |
| `src/talking-thinking.ts` | Realtime front delegating to a background reasoner. **Runnable.** |
| `src/observability-dashboard.ts` | A `MetricsExporter` + session helper. A module to import, not a script. |
| `src/university-support-observer.ts` | The background-observer guardrail plugin. A module to import, not a script. |
| `src/run-one-turn.ts` | The shared harness: env loading, WAV reading, and `runOneTurn()` returning transcript, reply, output WAV, and per-stage metrics. |

## Script families

Run `pnpm run` to list all 60. They group as:

- **`review:*`** — interactive servers you drive by hand. `review:studio` (browser +
  mic), `review:telephony`, `review:synthetic-carrier`.
- **`smoke:*-emulator`** — carrier emulators (Twilio, Telnyx, SmartPBX). No carrier
  account needed; they speak the real media-stream wire protocol locally.
- **`smoke:*-carrier-call`** — the real thing. Needs live carrier credentials.
- **`smoke:realtime-*` / `smoke:half-cascade-*`** — the speech-to-speech and
  hybrid fronts, per provider and per behaviour (barge-in, multiturn, one turn).
- **`smoke:fullduplex-examiner`**, **`smoke:interaction-eval-matrix`**,
  **`smoke:eva-bench-examiner`** — conversation-level evaluation: an LLM examiner
  holds a real two-party conversation and a judge scores it. See the
  [Testing guide](https://syrinx.asyncdot.com/reference/testing/).
- **`smoke:reasoner-latency-gate`**, **`smoke:turn-latency`** — latency benchmarks.

Most smokes call live providers and cost money. `SYRINX_WS_MAX_TURNS=1` shortens
the multi-turn ones while iterating.

## Tests

```bash
pnpm test        # vitest — the harness's own tests, no providers needed
pnpm typecheck
```

Note the distinction that matters here: `pnpm test` proves the harness works;
the `smoke:*` scripts prove **Syrinx** works. A green `pnpm test` is not evidence
that a provider integration is healthy.
