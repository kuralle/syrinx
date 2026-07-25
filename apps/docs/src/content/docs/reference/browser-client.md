---
title: Browser client SDK
description: Build your own voice UI on the Syrinx WebSocket protocol — mic capture, playback, the typed message stream, and structured session state.
---

`@kuralle-syrinx/browser-client` is the SDK for talking to a Syrinx agent from a browser. Microphone capture, opus encoding, jitter-buffered playback, reconnect — and the typed stream of everything the agent tells you.

**This is what you build your own voice UI on.** Syrinx Studio is built entirely on it.

```bash
npm install @kuralle-syrinx/browser-client
```

## Connect and talk

```ts
import { SyrinxBrowserClient } from '@kuralle-syrinx/browser-client';

const client = new SyrinxBrowserClient({
  url: 'ws://localhost:4173/ws',
  audioContext: new AudioContext(),
  jitterBuffer: { targetBufferMs: 100 },
});

client.on((event) => {
  if (event.type !== 'message') return;
  if (event.message.type === 'stt_output') console.log('you said:', event.message.transcript);
  if (event.message.type === 'agent_chunk') console.log(event.message.text);
});

await client.connect();
```

Send a turn as text instead of speaking — the reasoner and your tools run for real, with no STT or TTS cost:

```ts
client.sendText("What's the deadline?");
```

## What the agent sends back

`SyrinxStudioMessage` is a discriminated union of about twenty variants: `ready`, `speech_started`/`speech_ended`, `stt_chunk`/`stt_output`, `agent_chunk`/`agent_end`, `agent_tool_call`/`agent_tool_result`, the four `tool_call_*` cue phases, `agent_interrupted` (with a **reason**), `turn_complete`, `tts_chunk`/`tts_end`, `metrics`, and `error`.

:::caution[Ignore what you do not recognise]
On Cloudflare the agents SDK also emits `cf_agent_identity` and `cf_agent_mcp_servers`, which are **not** in this union — and future versions will add more. Skip unknown types rather than throwing.
:::

## Structured session state

Folding that stream by hand is tedious and easy to get subtly wrong. `/record` does it for you, and is **dependency-free and DOM-free**, so the same code runs in a browser, in Node, and in CI:

```ts
import { buildSessionRecord } from '@kuralle-syrinx/browser-client/record';

const record = buildSessionRecord(messages.map((m, i) => ({ message: m, atMs: i })));

record.turns[0]?.userTranscript;
record.turns[0]?.agentText;
record.turns[0]?.interrupted;   // { atMs, reason } when barge-in cut it off
record.turns[0]?.toolCalls;     // merged across all four cue phases
```

It is a **pure reducer** — same messages in, same record out — so you can render a UI from a recorded fixture in a test instead of needing a live provider. It is also **bounded** (50 turns, 500 events per turn by default), evicting oldest and reporting `droppedTurns` / `droppedEvents` rather than losing data silently.

:::caution[`timings` is optional — handle its absence]
It comes from the `metrics` message, which the Node host emits and the **Cloudflare Workers path currently does not**. Render a turn without timings rather than assuming they arrive; showing zeroes would read as a zero-latency turn.
:::

## Derived views

```ts
import { deriveAgentState, isStalled } from '@kuralle-syrinx/browser-client/agent-state';
import { buildTurnTimeline } from '@kuralle-syrinx/browser-client/turn-timeline';
import { buildSessionMetrics } from '@kuralle-syrinx/browser-client/session-metrics';
```

**`agent-state`** derives `idle → listening → endpointing → thinking → speaking → interrupted` — what you render as a listening indicator. This is *conversational* state; [`SessionState`](/reference/packets/) in core is session lifecycle and is a different thing. `isStalled` flags a state held past plausibility, because a thirty-second "thinking" is a hung tool call, not patience.

**`turn-timeline`** turns `metrics` into a latency waterfall with the slowest segment marked. It flags replies faster than 700ms: **a sub-second reply usually means the endpointer fired while the caller was still speaking**, not that the agent is fast.

**`session-metrics`** gives median / p95 / max per stage. Percentiles are nearest-rank, so every number reported is a measurement that actually occurred rather than an interpolation no turn produced.

## Exports

| Path | Contents | Node-safe |
| --- | --- | --- |
| `.` | client, transport, audio, message types | ✗ needs `AudioContext` |
| `./record` | `SessionRecord` assembler | ✓ |
| `./agent-state` | conversational state machine | ✓ |
| `./turn-timeline` | per-turn latency waterfall | ✓ |
| `./session-metrics` | session aggregates | ✓ |

## Next

- [Run it locally](/getting-started/run-it-locally/) — get an agent up to point this at.
- [Testing an agent](/reference/testing/) — the record is what your assertions read.
