// SPDX-License-Identifier: MIT
//
// `syrinx text "<message>"` — a typed turn against an already-built
// VoiceAgentSession (the same `--agent`-supplied session `driveTurn` runs
// audio through). Pushes the real shipped path — `user.text_received` — the
// same packet examples/02-hello-voice-headless/scripts/run-realtime-gemini-sendtext-smoke.ts
// drives, so a typed turn exercises exactly the pipeline a spoken one would,
// minus STT. This module never constructs a reasoner/provider itself; the
// session (and everything it can do) is entirely the caller's.

import { randomUUID } from "node:crypto";

import { Route, type VoiceAgentSession, type VoiceAgentSessionEvents } from "@kuralle-syrinx/core";

import { CliError, EXIT_CODES } from "./exit-codes.js";
import type { SessionFactory } from "./turn-runner.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface DriveTextOptions {
  /** An already-registered VoiceAgentSession, or a factory producing one. Built by the caller — this module never constructs a reasoner. */
  readonly session: VoiceAgentSession | SessionFactory;
  readonly message: string;
  readonly timeoutMs?: number;
}

export interface TextTurnResult {
  readonly reply: string;
  readonly ttftMs: number;
  readonly totalMs: number;
  readonly toolCalls: number;
}

async function resolveSession(session: VoiceAgentSession | SessionFactory): Promise<VoiceAgentSession> {
  return typeof session === "function" ? session() : session;
}

/** Send one typed turn to an already-built session and report the reply. */
export async function driveText(opts: DriveTextOptions): Promise<TextTurnResult> {
  const session = await resolveSession(opts.session);
  const contextId = randomUUID();

  const t0 = performance.now();
  let ttftMs = -1;
  let reply = "";
  let toolCalls = 0;

  const on = <K extends keyof VoiceAgentSessionEvents>(event: K, handler: VoiceAgentSessionEvents[K]): void => {
    session.on(event, handler);
  };

  const finished = new Promise<void>((resolveFinished, reject) => {
    const timeout = setTimeout(() => {
      reject(new CliError(EXIT_CODES.BACKEND, `agent did not finish within ${String(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    on("agent_text_delta", (event) => {
      if (event.turnId !== contextId) return;
      if (ttftMs < 0) ttftMs = performance.now() - t0;
      reply += event.delta;
    });
    on("agent_tool_call", (event) => {
      if (event.turnId !== contextId) return;
      toolCalls += 1;
    });
    on("agent_finished", (event) => {
      if (event.turnId !== contextId) return;
      clearTimeout(timeout);
      resolveFinished();
    });
    on("error", (event) => {
      clearTimeout(timeout);
      reject(new CliError(EXIT_CODES.BACKEND, `agent failed: ${event.message} (${event.stage}/${event.category})`));
    });
  });

  // `session.start()` below can throw before `await finished` is ever reached — an
  // init failure raises BOTH. In that case the `error` handler still rejects this
  // promise, and with nothing awaiting it Node reports an unhandled rejection and
  // prints a stack trace AFTER the command has already written its clean `--json`
  // object. Attaching a no-op handler marks it handled; `await finished` below still
  // observes the rejection, because `.catch()` returns a new promise and does not
  // consume this one.
  void finished.catch(() => {});

  try {
    await session.start();
    session.bus.push(Route.Main, {
      kind: "user.text_received",
      contextId,
      timestampMs: Date.now(),
      text: opts.message,
    });
    await finished;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(EXIT_CODES.BACKEND, `agent failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await session.close().catch(() => {});
  }

  return {
    reply,
    ttftMs: ttftMs < 0 ? 0 : Math.round(ttftMs),
    totalMs: Math.round(performance.now() - t0),
    toolCalls,
  };
}
