---
title: Testing an agent
description: Three levels of test for a voice agent — provider-free unit tests, deterministic fixture turns, and simulated conversations scored by a judge.
---

Voice agents fail in ways a green unit suite happily reports as healthy: a turn that never closes, a barge-in that doesn't cut audio, a stage that silently stops billing. The gap is real enough that it has bitten this codebase — a usage meter passed its unit test on the default endpointing path and emitted nothing on the flagship one, because the test chose the config the bug wasn't in.

So test at three levels, and be honest about what each one can and cannot prove.

## Level 1 — Provider-free unit tests

:::caution[Internal tooling — it cannot judge your agent]
`@kuralle-syrinx/test` is the scripted fake set Syrinx uses on **its own** unit
tests. It is published because the workspace depends on it across package
boundaries, not as a supported way to test an agent you are building.

The fakes prove wiring: a turn advances, an interruption is handled, an error does
not kill the session. They cannot tell you whether your agent understood the caller,
because the transcript is one *you* wrote — a suite of these passes happily while
the agent is unusable. **Level 2 is the one that actually checks your agent.**
:::

`FakeSTT`, `FakeTTS`, `FakeVAD` and `FakeBridge` each take their script through the
session's `plugins` config and emit it in order, so a whole turn runs with no network
and no keys:


```ts
import { VoiceAgentSession } from '@kuralle-syrinx/core';
import { FakeSTT, FakeBridge, FakeTTS } from '@kuralle-syrinx/test';

const stt = new FakeSTT();
const session = new VoiceAgentSession({
  plugins: {
    stt: {
      scriptedEvents: [
        { kind: 'interim', text: 'when is the' },
        { kind: 'final', text: 'when is the deadline?', confidence: 0.95, ts: Date.now() },
      ],
    },
    bridge: {
      scriptedEvents: [
        { kind: 'tool_call', id: '1', name: 'lookupDeadline', args: { program: 'cs' } },
        { kind: 'tool_result', id: '1', result: 'March 1' },
        { kind: 'text', delta: 'The deadline is March 1.' },
        { kind: 'done' },
      ],
    },
    tts: {},
  },
});

session.registerPlugin('stt', stt);
session.registerPlugin('bridge', new FakeBridge());
session.registerPlugin('tts', new FakeTTS());
await session.start();

await stt.emitScripted('turn-1'); // drive the scripted transcript
```

`FakeBridge` subscribes to `eos.turn_complete` and replays its script when the turn closes, so tool-call ordering, observers, and barge-in handling are all exercised deterministically. Assert on the packets your code cares about.

For synthetic audio, core exports the same tone helpers its own suite uses — no fixture files needed:

```ts
import { synthesizeTonePcm16, mixPcm16, PRIMARY_SPEAKER_TONE_HZ } from '@kuralle-syrinx/core';

const speech = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 800 });
const silence = synthesizeTonePcm16({ frequencyHz: 0, durationMs: 1500, amplitude: 0 });
```

**What this level proves:** your wiring, your tools, your observers, your barge-in handling. **What it cannot prove:** that a real provider behaves the way your fake does. Keep the fake honest — when a provider surprises you, encode the surprise here.

## Level 2 — A deterministic turn against real providers

One fixture WAV in, one full turn out, with per-stage timings. This is the level that catches "it works, but only on the config I happened to test."

The pattern is [`hello-voice-agent.ts`](https://github.com/kuralle/syrinx/blob/main/examples/02-hello-voice-headless/src/hello-voice-agent.ts) — push 20 ms frames, feed trailing silence, wait for `tts.end`, assert on the transcript and reply. See [Run it locally](/getting-started/run-it-locally/) for running it.

Two rules make this level trustworthy:

- **Run it on the config you ship.** If production uses `endpointingOwner: 'smart_turn'`, a test on `provider_stt` is testing a different machine. Sweep both if you support both.
- **Assert on the packets, not just the text.** A turn that produced a reply but never emitted `usage.recorded`, or never emitted `tts.end`, is broken in a way a transcript assertion will not see.

Because it calls real providers, this level costs money and is not hermetic. Run it on a schedule and before releases, not on every commit.

## Level 3 — A simulated conversation, scored

A single turn cannot tell you whether the agent interrupts people, answers with a filler and never returns, or takes over while the caller is mid-sentence. For that you need a second party.

The repo's examiner drives one continuous session against your agent: an LLM plays a caller with a semantic goal, speaks its turns through TTS, waits for the agent's real response rather than a fixed timeout, and records both sides to a stereo WAV.

```bash
pnpm -C examples/02-hello-voice-headless smoke:fullduplex-examiner
```

Set `SYRINX_FDE_JUDGE=1` to score the transcript afterwards with an LLM judge — turn-taking fluency, instruction-following, whether each reply addressed the goal, and takeover rate. That last set of metrics exists because raw latency lied: an agent that answers in 75 ms by cutting the caller off looks fastest and is worst. Separating "spoke quickly" from "answered the question" is the whole point of the judge.

`SYRINX_FDE_DRY=1` runs the harness with deterministic stubs and no providers, which is enough to keep the harness itself under test in CI.

## What to do when a level disagrees with the one below it

Trust the higher level and fix the lower one. A green unit test under a failing live turn means the unit test encodes an assumption the provider does not share — that is a defect in the test, not noise. Add the discriminating case at level 1 so the regression is cheap to catch next time, then fix the code.

## Next

- [Run it locally](/getting-started/run-it-locally/) — the loop these tests are built on.
- [Observability](/reference/observability/) — the counters and events worth asserting.
