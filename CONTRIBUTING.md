# Contributing to Syrinx

> Orientation for anyone new to the codebase — agent or human. Read it top to
> bottom once and you'll know what Syrinx is, what to read in what order, how to
> run it, and the bar a change clears before it ships.

## What Syrinx is (30 seconds)

Syrinx is the self-hostable **voice / media-transport engine** behind
[Kuralle](https://github.com/kuralle) — the open alternative to closed "voice
agent API" platforms. It keeps provider and client quirks at the transport edge
and hands the agent runtime a clean stream of mono PCM16 audio. It runs on Node
**and** Cloudflare Workers (one hibernatable Durable Object per conversation).

Full pitch + edge-deploy + env config: [`README.md`](./README.md). Don't
duplicate it here — start there.

## Orientation — read in this order

1. **[`README.md`](./README.md)** — what it is, what it provides, how to deploy
   to the edge, which env keys it reads.
2. **[`docs/websocket-audio-protocol.md`](./docs/websocket-audio-protocol.md)** —
   the wire protocol (mono PCM16, turn/session management, sequence +
   sample-rate locks, reconnect window). This is the heart of the system;
   everything else serves it.
3. **[`examples/02-hello-voice-headless/`](./examples/02-hello-voice-headless)** —
   run it (see [Run it locally](#run-it-locally)). One turn, Deepgram STT →
   OpenAI → Cartesia TTS, driven through a WAV fixture. The fastest way to feel
   the pipeline end to end.
4. **The architecture seam** — [`packages/core/README.md`](./packages/core/README.md)
   (the **Reasoner seam**: how the audio pipeline hands off to *any* LLM/agent
   backend) + [`docs/reasoner-bridge.md`](./docs/reasoner-bridge.md) and its
   design of record [`docs/rfc-reasoner-bridge.md`](./docs/rfc-reasoner-bridge.md)
   (how AI-SDK and Mastra agents plug in via `@kuralle-syrinx/aisdk` / `mastra`).
5. **Go deeper, by interest:**
   - Deployment: [`docs/serverless-edge-port-implementation-notes.md`](./docs/serverless-edge-port-implementation-notes.md) (Workers Durable-Object design), [`docs/serverless-portability-review.md`](./docs/serverless-portability-review.md) (Node-vs-edge constraints)
   - Performance: [`docs/latency-budget.md`](./docs/latency-budget.md) (the ~800 ms–1 s voice-to-voice budget)
   - Providers: [`PROVIDER-TESTING.md`](./PROVIDER-TESTING.md) (the provider test matrix)

## The package map

16 packages, all scoped `@kuralle-syrinx/*` under `packages/`:

| Area | Packages |
|---|---|
| Core | `core` — pipeline primitives + the Reasoner seam |
| Transport (client/server) | `ws` (outbound provider socket manager) · `server-websocket` (inbound host + telephony: Twilio/Telnyx/SmartPBX) |
| Edge runtime | `server-workers` · `server-workers-mastra` (Cloudflare Workers Durable Objects) |
| Browser / capture | `browser-client` · `recorder` |
| STT / TTS providers | `deepgram` (STT **and** TTS) · `google` · `cartesia` · `gemini` |
| Turn-taking | `silero-vad` · `pipecat-smart-turn` |
| Reasoner bridges | `aisdk` · `mastra` |
| Test helpers | `test` (shared fixtures/util library — no own test suite) |

Each provider/bridge package has (or will have) its own `README.md` with the
plugin's config keys.

## Run it locally

Prereqs: **Node 22**, **pnpm 11** (the repo pins `pnpm@11.4.0` via
`packageManager`; `corepack enable` will honor it).

```bash
pnpm install                      # links the workspace

# Provider keys: copy your keys into a local .env (gitignored, never committed).
# The full key list is in README.md → Configuration
# (OPENAI_API_KEY, DEEPGRAM_API_KEY, CARTESIA_API_KEY, GEMINI_API_KEY, ...).

# Drive one full turn through a WAV fixture (needs Deepgram + OpenAI + Cartesia keys):
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless dev
```

Edge deploy (Cloudflare Workers, runs the full engine in a Durable Object):

```bash
pnpm --filter @kuralle-syrinx/server-workers exec wrangler deploy
```

See `README.md` for the deployed endpoints (`/ws`, `/health`, `/recordings`)
and R2 recording setup.

## Verify your change (the bar)

Unit/integration tests are mocked and need **no** API keys:

```bash
pnpm -r typecheck                              # type-check the whole workspace
pnpm -r test                                   # run every package's vitest suite
pnpm --filter @kuralle-syrinx/<pkg> test       # one package
```

Live, key-dependent checks (real provider round-trips) live in
[`PROVIDER-TESTING.md`](./PROVIDER-TESTING.md) and the example's `smoke:*`
scripts — run these when a change touches a provider or the live audio path.

A change is "done" when its test exists, the whole-workspace suite is still
green, and — for anything on the audio path — you've observed it end to end
(run the example, not just the unit tests).

## Conventions

- **Monorepo**: pnpm workspace, `packages/*` + `examples/*`. TypeScript, ESM
  (`"type": "module"`), tested with **vitest**.
- **Naming**: scope `@kuralle-syrinx/*`, short package names (no `voice-`
  prefix); providers are grouped by vendor (e.g. `deepgram` ships both STT and
  TTS, via `./stt` and `./tts` subpaths).
- **Commits**: conventional-ish prefixes (`feat:` / `refactor:` / `fix:` /
  `chore:` / `docs:`), atomic — one logical change per commit. Name files when
  staging; never `git add -A` blind. Never commit `.env` or secrets.
- **Don't** add speculative abstractions, flags, or config that nothing asks for.
  Keep changes surgical.

## Where deeper material lives

- **Design records**: `docs/rfc-*.md`. Program summaries: `docs/reasoner-bridge.md`.
- **Research & internal reviews** (prior-art notes, bug-hunt reports, the
  production checklist) live in the **private** repo
  `octalpixel/kuralle-syrinx-research` — ask a maintainer for access. They are
  intentionally **not** in this public repo.

## If you're an AI agent picking this up

Suggested Claude Code skills for common tasks in this repo:

- **`/run`** — launch the example app to see a change working.
- **`/verify`** — confirm a fix actually works by running it, not just the tests.
- **`/tdd`** — test-first for new features / bug fixes (red → green → refactor).
- **`/code-review`** — review the diff for bugs + simplification before a PR.

Before touching transport, map the contract from
`docs/websocket-audio-protocol.md` first — the protocol is the source of truth,
the code serves it.

---

**TL;DR for a newcomer:** read [`README.md`](./README.md) →
[`docs/websocket-audio-protocol.md`](./docs/websocket-audio-protocol.md) → run
`examples/02-hello-voice-headless`
(`pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless dev`) → then
[`packages/core/README.md`](./packages/core/README.md) +
[`docs/reasoner-bridge.md`](./docs/reasoner-bridge.md) for how agents plug in.
