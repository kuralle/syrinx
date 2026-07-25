# @kuralle-syrinx/browser-client

The browser SDK for the Syrinx WebSocket voice protocol. Microphone capture,
opus encoding, jitter-buffered playback, reconnect — and the typed message
stream a voice agent sends back.

**This is what you build your own voice UI on.** [Syrinx Studio](https://github.com/kuralle/syrinx/tree/main/apps/studio)
is built entirely on it; so is anything you want to embed voice into.

```bash
npm install @kuralle-syrinx/browser-client
```

## Talk to an agent

```ts
import { SyrinxBrowserClient } from "@kuralle-syrinx/browser-client";

const client = new SyrinxBrowserClient({
  url: "ws://localhost:4173/ws",
  audioContext: new AudioContext(),
  jitterBuffer: { targetBufferMs: 100 },
});

client.on((event) => {
  if (event.type === "message" && event.message.type === "stt_output") {
    console.log("you said:", event.message.transcript);
  }
  if (event.type === "message" && event.message.type === "agent_chunk") {
    process.stdout.write(event.message.text);
  }
});

await client.connect();
```

Send a turn as text instead of speaking — useful for iterating on prompts and
tools without paying STT/TTS latency or cost:

```ts
client.sendText("What's the deadline for the CS masters?");
```

## What the server sends you

`SyrinxStudioMessage` is a discriminated union of roughly twenty variants. The
ones you will reach for first:

| Message | Carries |
| --- | --- |
| `ready` | negotiated sample rates, encoding, resume window |
| `speech_started` / `speech_ended` | turn boundaries |
| `stt_chunk` / `stt_output` | interim and final transcript (+ confidence) |
| `agent_chunk` / `agent_end` | the reply, streamed |
| `agent_tool_call` / `agent_tool_result` | tool use |
| `tool_call_started` \| `delayed` \| `complete` \| `failed` | the "thinking" cue lifecycle |
| `agent_interrupted` | barge-in, **with a reason** |
| `turn_complete`, `tts_chunk`, `tts_end` | turn and audio lifecycle |
| `metrics` | per-turn latency decomposition |
| `error` | `component`, `category`, `message` |

> **Handle unknown types gracefully.** On Cloudflare the agents SDK also emits
> `cf_agent_identity` and `cf_agent_mcp_servers`, which are not in this union,
> and future versions will add more. Ignore what you do not recognise rather
> than throwing.

## Structured session state — `/record`

Folding that stream by hand is tedious and easy to get wrong. The `/record`
subpath does it for you, and is **dependency-free and DOM-free** so it also runs
under Node (in a test, a CLI, or CI):

```ts
import { buildSessionRecord } from "@kuralle-syrinx/browser-client/record";

const record = buildSessionRecord(messages.map((m, i) => ({ message: m, atMs: i })));

record.turns[0]?.userTranscript;  // what the caller said
record.turns[0]?.agentText;       // what the agent replied
record.turns[0]?.interrupted;     // { atMs, reason } when barge-in cut it off
record.turns[0]?.toolCalls;       // merged across all four cue phases
record.turns[0]?.timings;         // optional — see the caveat below
```

It is a **pure reducer**: same messages in, same record out, no side effects.
That is what lets you render a UI from a recorded fixture in a test instead of
needing a live provider.

It is also **bounded** — 50 turns and 500 events per turn by default, evicting
oldest and reporting `droppedTurns` / `droppedEvents` rather than losing data
silently.

> **`timings` is optional and you must handle its absence.** It comes from the
> `metrics` message, which the Node host emits and the Cloudflare Workers path
> currently does not. Render a turn without timings rather than assuming they
> arrive — showing zeroes would read as a zero-latency turn.

## Derived views — `/agent-state` and `/turn-timeline`

Both are pure, Node-safe, and derived from the same record.

```ts
import { deriveAgentState, isStalled } from "@kuralle-syrinx/browser-client/agent-state";
import { buildTurnTimeline } from "@kuralle-syrinx/browser-client/turn-timeline";
```

`deriveAgentState` gives you `idle → listening → endpointing → thinking →
speaking → interrupted` — what a client renders as a listening indicator. Note
this is *conversational* state; `SessionState` in `@kuralle-syrinx/core` is
session lifecycle and is a different thing. `isStalled` flags a state held far
past plausibility, because a thirty-second "thinking" is a hung tool call, not
patience.

`buildTurnTimeline` turns `metrics` into a latency waterfall with the slowest
segment marked. It also flags replies faster than `FAST_TURN_FLOOR_MS` (700ms) —
**a sub-second reply is usually the endpointer firing while the caller is still
speaking**, not a fast agent.

## Session aggregates — `/session-metrics`

```ts
import { buildSessionMetrics } from "@kuralle-syrinx/browser-client/session-metrics";
```

Median / p95 / max per stage across a session, plus the ids of turns that
replied implausibly fast. Percentiles are **nearest-rank**, so every number
reported is a measurement that actually occurred rather than an interpolation no
turn ever produced.

## Exports

| Path | Contents | Runs under Node? |
| --- | --- | --- |
| `.` | client, transport, audio, message types | no — needs `AudioContext` |
| `./record` | `SessionRecord` assembler | yes |
| `./agent-state` | conversational state machine | yes |
| `./turn-timeline` | per-turn latency waterfall | yes |
| `./session-metrics` | session aggregates | yes |

## Licence

MIT.
