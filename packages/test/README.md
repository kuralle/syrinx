# @kuralle-syrinx/test

Scripted fake plugins used by **Syrinx's own unit tests**.

> Scripted fake STT/TTS/LLM plugins for testing Syrinx voice pipelines

## This is internal tooling, not the way to test your agent

These fakes exist so the engine's own test suite can assert turn-taking,
interruption and error handling deterministically, without a provider. They are
published because the workspace depends on them across package boundaries — not
because they are a supported way to test an agent you are building.

If you are testing your own voice agent, use fixtures instead. That path is real,
end-to-end, and asserts the thing you actually care about:

```bash
# 1. Talk to your agent in the Studio, then "Save as fixture" on the turn.
#    You get a WAV plus a sidecar carrying the expected transcript AND the
#    capture config (sample rate, encoding) — a fixture without its config
#    silently misleads on replay.

# 2. Replay it. Exits non-zero when the transcript drifts.
syrinx turn --in ./fixtures/my-turn.json --agent ./src/agent.ts#createAgent --json
```

That runs your real pipeline against real providers and compares against a
transcript a real caller produced — which a scripted fake, by construction, cannot
tell you anything about.

See [Recording a call](https://syrinx.asyncdot.com/reference/recording/) and
[Testing an agent](https://syrinx.asyncdot.com/reference/testing/).

## What is in here

`FakeSTT`, `FakeTTS`, `FakeBridge`, `FakeVAD` — each a `VoicePlugin` whose script
arrives through the session's `plugins` config (`scriptedEvents`,
`scriptedAudioBatches`, `scriptedSpeechProbabilities`), like any other plugin's
config. They take no constructor arguments.

Read `packages/cli/src/turn-runner.test.ts` in the repository for a working wiring.

## License

MIT
