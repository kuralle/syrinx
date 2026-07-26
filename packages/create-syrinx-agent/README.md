# create-syrinx-agent

Scaffold a [Syrinx](https://github.com/kuralle/syrinx) voice agent project.

```bash
npm create syrinx-agent my-agent -- --stt deepgram --reasoner aisdk --tts cartesia
```

One generator with conditional emission, not a directory of templates. You pick a provider
per pipeline stage and get back a project that depends on **exactly those** providers, with
a `.env.example` naming exactly the keys they need.

## Pick a pipeline

**Cascade** — speech in, text through a reasoner, speech out:

```bash
npm create syrinx-agent my-agent -- \
  --stt deepgram --reasoner aisdk --tts cartesia
```

| Flag | Options |
| --- | --- |
| `--stt` | `deepgram` · `google` · `elevenlabs` · `grok` |
| `--tts` | `cartesia` · `elevenlabs` · `gemini` · `openai-tts` · `grok` |
| `--reasoner` | `aisdk` (any `ai@6` model) · `kuralle` · `mastra` |
| `--vad` | `silero-vad` — optional; provider STT owns it by default |
| `--endpointing` | `pipecat-smart-turn` · `vap` — optional |

**Speech-to-speech** — one model hears and speaks, no separate stages:

```bash
npm create syrinx-agent my-agent -- --realtime realtime
```

`--realtime` is exclusive with `--stt`/`--tts`, and passing them together is refused rather
than silently ignored — a speech-to-speech pipeline has no separate stages to configure.

## Transport and runtime

```bash
--transport browser|twilio|telnyx|smartpbx     # default: browser
--runtime   node|cloudflare                    # default: node
```

`--runtime cloudflare --transport telnyx` generates, but warns: Telnyx is not yet bound on
the Workers edge, so that combination is deploy-unverified.

## Presets

Flag bundles, and an explicit flag always wins:

```bash
npm create syrinx-agent support-line -- --preset phone --tts elevenlabs
```

## Other options

```
--name <project-name>   default: the target directory's basename
--yes                   accept defaults, never prompt
--no-install            write the project, skip npm install
--dry-run               print the file list and exit
```

## What you get

```
src/agent.ts            createAgent() — the --agent seam's factory export
scripts/dev-server.ts   pnpm dev — local server, mic in the browser
test/fixtures/          a fixture for the headless check
.env.example            exactly the keys your combination needs
AGENTS.md               what a coding agent can and cannot verify here
package.json            only the providers you chose
```

The generated project wires to the same `--agent <module>#<export>` seam that Syrinx's dev
server and [`@kuralle-syrinx/cli`](https://www.npmjs.com/package/@kuralle-syrinx/cli) use, so
`pnpm dev` and `syrinx turn` drive the identical agent.

## Two operators

The generated `AGENTS.md` is written for a coding agent, and it is explicit about the line
it cannot cross. An agent can assert transcripts, exit codes and latency numbers. It cannot
judge whether barge-in feels natural, whether a pause reads as thinking or as a hang, or
whether a voice sounds warm. Those need a person listening in the studio, and pretending
otherwise is how a green check becomes false confidence.

## License

MIT
