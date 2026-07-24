---
title: Background observer
description: Watch turns with a background LLM and steer the next reply — without blocking or being heard.
---

A background observer is a second model that watches the conversation as it happens and quietly corrects course. It runs **off the critical path** — it never blocks the reply the caller is waiting for — and when it finds something (a policy slip, a missed detail, a wrong assumption), it biases the agent's **next** turn silently, without speaking. This is the observer-guardrail pattern.

## How it works

An observer is a plugin that:

1. Subscribes to `eos.turn_complete` on the session bus.
2. Runs its analysis **asynchronously** per turn — a background LLM call — without awaiting it on the turn path.
3. On a finding, pushes an `inject.message` packet with `mode: "context"`. The session hands that text to the reasoner's `injectContext()`, which folds it into the next turn's prompt. Because the mode is `"context"` (not spoken output), the caller never hears the correction — the agent just handles the next turn better.

```ts
import {
  Route,
  type EndOfSpeechPacket,
  type InjectMessagePacket,
  type PipelineBus,
  type PluginConfig,
  type VoicePlugin,
} from '@kuralle-syrinx/core';

export class PolicyObserver implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private dispose: (() => void) | null = null;

  // `evaluate` is your background analysis — an LLM call returning a correction, or null.
  constructor(private readonly evaluate: (turn: { contextId: string; text: string }) => Promise<string | null>) {}

  async initialize(bus: PipelineBus, _config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.dispose = bus.on<EndOfSpeechPacket>('eos.turn_complete', (turn) => {
      // Fire-and-forget: never block the turn the caller is waiting on.
      void this.analyze({ contextId: turn.contextId, text: turn.text });
    });
  }

  private async analyze(turn: { contextId: string; text: string }): Promise<void> {
    const correction = await this.evaluate(turn);
    if (!correction) return;
    this.bus?.push(Route.Background, {
      kind: 'inject.message',
      contextId: turn.contextId,
      timestampMs: Date.now(),
      text: correction,
      mode: 'context', // silent — biases the next turn, never spoken
    } satisfies InjectMessagePacket);
  }

  async close(): Promise<void> {
    this.dispose?.();
    this.bus = null;
  }
}
```

Register it on the session like any other plugin:

```ts
session.registerPlugin('observer', new PolicyObserver(myEvaluator));
```

## Silent vs. spoken injection

The `inject.message` packet has a `mode`:

- **`"context"`** — folded into the reasoner's context for the next turn via `injectContext()`. Never spoken. Use it to steer the agent.
- Omit `mode` — injected as synthetic assistant output and spoken through TTS. Use it to make the agent say something directly.

Context injection requires the reasoner to support `injectContext` (the cascade `ReasoningBridge` does, and realtime fronts inject it as a context item). If it doesn't, the session logs a warning rather than failing silently.

## Keep it off the critical path

The whole point is that analysis latency never touches voice-to-voice latency. Don't `await` the evaluation on the turn path — fire it and let the correction land on a later turn. A good observer also de-duplicates (don't inject the same correction twice) and can drop stale evaluations when turns arrive faster than it can analyze them.

A complete, runnable observer — a university-support guardrail that evaluates each turn and injects corrections — is in [`university-support-observer.ts`](https://github.com/kuralle/syrinx/blob/main/examples/02-hello-voice-headless/src/university-support-observer.ts).

## See also

- [Observability & analytics](/reference/observability/) — the signals an observer (and your dashboards) read.
