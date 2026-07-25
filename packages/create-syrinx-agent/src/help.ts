// SPDX-License-Identifier: MIT

export const HELP_TEXT = `create-syrinx-agent — scaffold a Syrinx voice agent project.

One generator with conditional emission, not enumerated template directories:
pick a provider per pipeline stage with flags and get back a project that
depends on exactly those providers and typechecks out of the box.

USAGE
  npm create syrinx-agent <target-dir> [options]
  create-syrinx-agent <target-dir> [options]

PIPELINE (cascade mode — pick one provider per stage)
  --stt <deepgram|google|elevenlabs|grok>
  --tts <cartesia|elevenlabs|gemini|openai-tts|grok>
  --reasoner <aisdk|kuralle|mastra>
  --vad <silero-vad>                        optional, provider STT/endpointing owns it by default
  --endpointing <pipecat-smart-turn|vap>     optional, provider STT owns it by default

PIPELINE (speech-to-speech — exclusive with --stt/--tts)
  --realtime <realtime|grok>
      A speech-to-speech pipeline has no separate STT/reasoner/TTS stages.
      Passing --stt or --tts alongside --realtime is refused.

TRANSPORT
  --transport <browser|twilio|telnyx|smartpbx>   default: browser
  --runtime <node|cloudflare>                    default: node
      --runtime cloudflare --transport telnyx is generated but warned as
      deploy-unverified on the Workers edge.

PRESETS (flag bundles — an explicit flag always overrides the preset)
  --preset <phone>

OPTIONS
  --name <project-name>      default: the target directory's basename
  --yes                      accept defaults for anything not passed, never prompt
  --no-install, --skip-install
                              write the project but skip \`npm install\`
  --dry-run                  print the file list and exit; write nothing
  --help, -h                 show this help
  --version, -v               print the generator's version

Never prompts when --yes is passed or stdin is not a TTY: missing required
flags fail with a USAGE error naming what is missing.
`;
