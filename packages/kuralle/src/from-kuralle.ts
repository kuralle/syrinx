// SPDX-License-Identifier: MIT

import type { Reasoner, ReasonerTurn, ReasoningPart } from "@kuralle-syrinx/core";
import { categorizeLlmError, isRecoverable } from "@kuralle-syrinx/core";

export interface KuralleStreamPart {
  readonly type: string;
  readonly delta?: string;
  readonly toolName?: string;
  readonly args?: unknown;
  readonly toolCallId?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly waitingFor?: string;
  readonly nodeId?: string;
  readonly options?: unknown;
  readonly prompt?: string;
  readonly sessionId?: string;
}

export interface KuralleMessageLike {
  readonly role: string;
  content: unknown;
}

export interface KuralleStoredSession {
  readonly id: string;
  messages: KuralleMessageLike[];
  [key: string]: unknown;
}

export interface KuralleSessionStoreLike {
  get(id: string): Promise<KuralleStoredSession | null>;
  save(session: KuralleStoredSession): Promise<void>;
}

export interface KuralleTurnHandle {
  readonly events: AsyncIterable<KuralleStreamPart>;
  then?: PromiseLike<unknown>["then"];
}

export interface KuralleRunOptions {
  readonly input?: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly abortSignal?: AbortSignal;
  readonly historyDelta?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
}

export interface KuralleRuntimeLike {
  run(opts: KuralleRunOptions): KuralleTurnHandle;
  getSession?(sessionId: string): Promise<KuralleStoredSession | null>;
  getSessionStore?(): KuralleSessionStoreLike;
}

export interface FromKuralleRuntimeOptions {
  readonly sessionId: string;
  readonly userId?: string;
  readonly agentId?: string;
}

const DURABLE_RUNS_KEY = "durableRuns";

export function fromKuralleRuntime(runtime: KuralleRuntimeLike, opts: FromKuralleRuntimeOptions): Reasoner {
  return { stream: (turn) => streamFromKuralle(runtime, turn, opts) };
}

async function buildKuralleRunOptions(
  runtime: KuralleRuntimeLike,
  turn: ReasonerTurn,
  opts: FromKuralleRuntimeOptions,
): Promise<KuralleRunOptions> {
  const base: KuralleRunOptions = {
    sessionId: opts.sessionId,
    userId: opts.userId,
    agentId: opts.agentId,
    abortSignal: turn.signal,
  };
  if (!turn.userText) return base;
  if (!runtime.getSession) {
    return { ...base, input: turn.userText };
  }
  const session = await runtime.getSession(opts.sessionId);
  const runState = readActiveRunState(session, opts.sessionId);
  if (runState?.activeFlow) {
    const appended = await appendFlowResumeUserMessage(runtime, opts.sessionId, turn.userText);
    if (appended) return base;
  }
  return { ...base, input: turn.userText };
}

export async function buildKuralleTurnRunOptions(
  runtime: KuralleRuntimeLike,
  params: FromKuralleRuntimeOptions & { readonly userText: string; readonly signal?: AbortSignal },
): Promise<KuralleRunOptions> {
  const turn: ReasonerTurn = {
    userText: params.userText,
    messages: [],
    signal: params.signal ?? new AbortController().signal,
  };
  return buildKuralleRunOptions(runtime, turn, params);
}

export function runKuralleTurn(
  runtime: KuralleRuntimeLike,
  runOpts: KuralleRunOptions,
): KuralleTurnHandle {
  return runtime.run(runOpts);
}

export async function awaitKuralleTurn(handle: KuralleTurnHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (typeof handle.then === "function") {
      handle.then(() => resolve(), reject);
      return;
    }
    resolve();
  });
}

function readActiveRunState(
  session: KuralleStoredSession | null,
  sessionId: string,
): { activeFlow?: string } | undefined {
  if (!session) return undefined;
  const runs = session[DURABLE_RUNS_KEY];
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) return undefined;
  const persisted = (runs as Record<string, unknown>)[sessionId];
  if (!persisted || typeof persisted !== "object") return undefined;
  const runState = (persisted as { runState?: { activeFlow?: string } }).runState;
  return runState;
}

async function appendFlowResumeUserMessage(
  runtime: KuralleRuntimeLike,
  sessionId: string,
  userText: string,
): Promise<boolean> {
  const store = runtime.getSessionStore?.();
  if (!store) return false;

  const session = await store.get(sessionId);
  if (!session) return false;

  const userMessage: KuralleMessageLike = { role: "user", content: userText };
  session.messages = [...session.messages, userMessage];

  const wm = session.workingMemory;
  if (wm && typeof wm === "object" && !Array.isArray(wm)) {
    delete (wm as Record<string, unknown>)["__v2_pendingUserInput"];
  }

  const runs = session[DURABLE_RUNS_KEY];
  if (runs && typeof runs === "object" && !Array.isArray(runs)) {
    const persisted = (runs as Record<string, unknown>)[sessionId];
    if (persisted && typeof persisted === "object") {
      const runState = (persisted as { runState?: { messages?: KuralleMessageLike[] } }).runState;
      if (runState) {
        runState.messages = [...(runState.messages ?? []), userMessage];
      }
    }
  }

  await store.save(session);
  return true;
}

export async function* streamFromKuralle(
  runtime: KuralleRuntimeLike,
  turn: ReasonerTurn,
  opts: FromKuralleRuntimeOptions,
): AsyncGenerator<ReasoningPart> {
  const runOpts = await buildKuralleRunOptions(runtime, turn, opts);
  const handle = runtime.run(runOpts);

  let acc = "";
  let aborted = false;
  try {
    for await (const part of handle.events) {
      if (turn.signal.aborted) {
        aborted = true;
        break;
      }
      switch (part.type) {
        case "text-delta": {
          const t = String(part.delta ?? "");
          acc += t;
          yield { type: "text-delta", text: t };
          if (turn.signal.aborted) {
            aborted = true;
          }
          break;
        }
        case "tool-call":
          yield {
            type: "tool-call",
            toolId: String(part.toolCallId ?? ""),
            toolName: String(part.toolName ?? ""),
            args: toRecord(part.args),
          };
          break;
        case "tool-result":
          yield {
            type: "tool-result",
            toolId: String(part.toolCallId ?? ""),
            toolName: String(part.toolName ?? ""),
            result: stringifyResult(part.result),
          };
          break;
        case "error":
          yield toErrorPart(new Error(String(part.error ?? "Kuralle error")));
          return;
        case "paused":
          yield {
            type: "suspended",
            runId: opts.sessionId,
            prompt: typeof part.waitingFor === "string" ? part.waitingFor : undefined,
            payload: part,
          };
          return;
        case "interactive":
          yield {
            type: "suspended",
            runId: opts.sessionId,
            prompt: typeof part.prompt === "string" ? part.prompt : undefined,
            payload: part,
          };
          return;
        case "done":
          yield { type: "finish", reason: "stop", text: acc };
          return;
        default:
          break;
      }
      if (aborted) break;
    }
  } finally {
    await awaitKuralleTurn(handle).catch(() => undefined);
    if (aborted && acc.length > 0) {
      await reconcileSpokenPrefix(runtime, opts.sessionId, acc);
    }
  }

  if (aborted) return;

  yield toErrorPart(new Error("Kuralle stream ended without a done part"));
}

export async function reconcileSpokenPrefix(
  runtime: KuralleRuntimeLike,
  sessionId: string,
  spokenPrefix: string,
): Promise<void> {
  const store = runtime.getSessionStore?.();
  if (!store) return;

  const session = await store.get(sessionId);
  if (!session) return;

  let changed = false;
  const topLevel = rewriteLastAssistant(session.messages, spokenPrefix);
  if (topLevel !== session.messages) {
    session.messages = topLevel;
    changed = true;
  }

  const runs = session[DURABLE_RUNS_KEY];
  if (runs && typeof runs === "object" && !Array.isArray(runs)) {
    for (const persisted of Object.values(runs as Record<string, unknown>)) {
      if (!persisted || typeof persisted !== "object") continue;
      const runState = (persisted as { runState?: { messages?: KuralleMessageLike[] } }).runState;
      if (!runState?.messages) continue;
      const rewritten = rewriteLastAssistant(runState.messages, spokenPrefix);
      if (rewritten !== runState.messages) {
        runState.messages = rewritten;
        changed = true;
      }
    }
  }

  if (changed) await store.save(session);
}

export function rewriteLastAssistant(
  messages: ReadonlyArray<KuralleMessageLike>,
  spokenPrefix: string,
): KuralleMessageLike[] {
  if (messages.length === 0) return [...messages];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return [...messages];
  const full = assistantText(last);
  if (spokenPrefix.length >= full.length) return [...messages];
  return [...messages.slice(0, -1), { role: "assistant", content: spokenPrefix }];
}

function assistantText(message: KuralleMessageLike): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String(part.text);
        return "";
      })
      .join("");
  }
  return String(message.content ?? "");
}

function toErrorPart(error: unknown): ReasoningPart {
  const cause = error instanceof Error ? error : new Error(String(error));
  return { type: "error", cause, recoverable: isRecoverable(categorizeLlmError(cause)) };
}

function stringifyResult(r: unknown): string {
  return typeof r === "string" ? r : JSON.stringify(r);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
