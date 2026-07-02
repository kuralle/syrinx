// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — AI SDK Bridge Plugin
//
// Bridges the PipelineBus to Vercel AI SDK for LLM inference.
// Listens for EOS turn completions, calls LLM, pushes deltas + done + tool calls
// into the bus. Handles LLM interrupts via AbortController.

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import {
  Route,
  type VoicePlugin,
  type PluginConfig,
  type Reasoner,
  type ReasonerSessionStore,
  type ReasonerTurn,
  type TtsWordTimestamp,
  categorizeLlmError,
  isRecoverable,
  readRetryConfig,
  waitForRetryDelay,
  ErrorCategory,
  type RetryConfig,
} from "@kuralle-syrinx/core";

export {
  fromAiSdkAgent,
  fromStreamText,
  fromStreamFactory,
  type AiSdkAgentLike,
  type StreamTextConfig,
} from "./from-ai-sdk.js";

export type AISDKBridgeTools = ToolSet;
export type AISDKStreamFactory = (request: {
  userText: string;
  signal: AbortSignal;
  messages: ModelMessage[];
}) => AsyncGenerator<TextStreamPart<ToolSet>>;

export interface RunPointer {
  readonly runId: string;
}

export interface RunStore {
  save(contextId: string, runId: string): void | Promise<void>;
  takePending(contextId: string): RunPointer | null | Promise<RunPointer | null>;
  discard(contextId: string): void | Promise<void>;
}

export class ReasoningBridge implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private timeoutMs: number = 30_000;
  private maxHistoryTurns: number = 12;
  private history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string }> = [];
  private activeGeneration: { contextId: string; controller: AbortController } | null = null;
  private retryConfig: RetryConfig = readRetryConfig({});
  private disposers: Array<() => void> = [];
  // G2/G25: per-turn state so a barged-in turn is remembered as what the user HEARD,
  // not the full generated reply. Precision ladder:
  //   1. Word timestamps (tts.word_timestamps) + playout position (tts.playout_progress)
  //      → exact spoken prefix at word boundaries.
  //   2. Fallback: spokenByContext (text sent to TTS) — approximate; may include audio
  //      that was queued but not yet played out (TTS streams faster than realtime).
  // `spokenByContext` accumulates tts.text; `assistantMsgByContext` holds the live
  // history message object so it can be rewritten in place; `turnUserText` lets a
  // mid-generation interrupt still record the turn.
  private spokenByContext = new Map<string, string>();
  private turnUserText = new Map<string, string>();
  private assistantMsgByContext = new Map<string, { role: "assistant"; content: string }>();
  // G25: word-level timestamps from TTS plugin (cumulative from context audio start).
  private wordTimestampsByContext = new Map<string, TtsWordTimestamp[]>();
  // G25: latest playout position (ms from context audio start) from the paced transport.
  // Present whenever a paced transport is wired — this includes the browser WebSocket
  // path (it routes through the shared paced playout pipeline + PlayoutProgressEmitter)
  // as well as telnyx/twilio/smartpbx. Only headless-direct (no playout clock) falls
  // back to spokenByContext.
  private playedOutMsByContext = new Map<string, number>();

  constructor(
    private readonly reasoner: Reasoner,
    private readonly opts: {
      runStore?: RunStore;
      onResumeConflict?: "restart" | "replay";
      /**
       * G4 durable session (RFC bimodel-delegate-seam): when set with `sessionId`, the
       * bridge loads its conversation history from the store on initialize and persists
       * the bounded snapshot after every committed (or interrupted-truncated) turn — a
       * bridge re-created after host eviction resumes with the same context.
       */
      sessionStore?: ReasonerSessionStore;
      sessionId?: string;
    } = {},
  ) {
    if (this.opts.onResumeConflict === "replay") {
      throw new Error("onResumeConflict 'replay' not yet supported — use 'restart'");
    }
  }

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.timeoutMs = readPositiveIntegerConfig(config["timeout_ms"], 30_000);
    this.maxHistoryTurns = readPositiveIntegerConfig(config["max_history_turns"], 12);
    this.retryConfig = readRetryConfig(config);

    // G4: resume from durable history — the reasoner's next turn sees the same
    // context as before the eviction/reconnect (R6). Load-only: nothing is spoken.
    if (this.opts.sessionStore && this.opts.sessionId) {
      const stored = await this.opts.sessionStore.load(this.opts.sessionId);
      this.history = stored.map((message) => ({ ...message }));
    }

    // Listen for EOS turn completions
    this.disposers.push(
      // Concurrent producer: a turn's LLM generation streams its own packets over
      // (potentially) several seconds. Running it fire-and-forget keeps the pipeline
      // bus drain loop free, so the llm.delta -> tts.text streaming it produces is
      // dispatched as it arrives (not deferred until generation ends), and Critical
      // interrupts are handled promptly mid-generation. processTurn supersedes any
      // still-in-flight generation (see below).
      bus.on("eos.turn_complete", async (pkt: unknown) => {
        const eos = pkt as { text: string; contextId: string };
        await this.processTurn(eos.text, eos.contextId);
      }, { concurrent: true }),

      // Track what was actually sent to TTS (fallback spoken approximation), per turn.
      bus.on("tts.text", (pkt: unknown) => {
        const t = pkt as { contextId: string; text: string };
        this.spokenByContext.set(t.contextId, (this.spokenByContext.get(t.contextId) ?? "") + t.text);
      }),

      // G25: accumulate word-level timestamps from the TTS plugin (Cartesia etc.).
      // These arrive as cumulative offsets from the context audio start and enable
      // word-boundary precision when computing the spoken prefix on barge-in.
      bus.on("tts.word_timestamps", (pkt: unknown) => {
        const t = pkt as { contextId: string; words: TtsWordTimestamp[] };
        const existing = this.wordTimestampsByContext.get(t.contextId);
        if (existing) {
          for (const w of t.words) existing.push(w);
        } else {
          this.wordTimestampsByContext.set(t.contextId, [...t.words]);
        }
      }),

      // G25: track realtime playout position from the paced transport. Absent on
      // headless/browser paths; in that case we fall back to spokenByContext.
      bus.on("tts.playout_progress", (pkt: unknown) => {
        const p = pkt as { contextId: string; playedOutMs: number };
        this.playedOutMsByContext.set(p.contextId, p.playedOutMs);
      }),

      // Listen for LLM interrupts. Abort generation AND rewrite the interrupted turn's
      // history to the spoken prefix (G2/G25), so the model isn't left believing it
      // said words the user never heard (nor amnesiac about the exchange).
      bus.on("interrupt.llm", (pkt: unknown) => {
        const contextId = (pkt as { contextId: string }).contextId;
        if (this.activeGeneration?.contextId === contextId) {
          this.activeGeneration.controller.abort();
          this.activeGeneration = null;
        }
        this.commitInterruptedHistory(contextId);
        if (this.opts.runStore && this.opts.onResumeConflict !== "replay") {
          void Promise.resolve(this.opts.runStore.discard(contextId)).catch(() => undefined);
        }
      }),
    );
  }

  private async processTurn(userText: string, contextId: string): Promise<void> {
    if (!this.bus) return;

    this.turnUserText.set(contextId, userText);

    // Handlers are concurrent, so a new turn can begin while a prior generation is
    // still in flight. Supersede it: abort the previous controller before starting.
    this.activeGeneration?.controller.abort();
    const controller = new AbortController();
    this.activeGeneration = { contextId, controller };
    const signal = controller.signal;

    let reply = "";
    let emittedDelta = false;
    let committed = false;
    let grounded = false;

    // G2 observability: the turn's query is on its way to the reasoner (Background
    // route, droppable — RFC bimodel-delegate-seam R4). Cascade turns have no
    // front-model tool call, so toolId/toolName are absent.
    const queryStartedMs = Date.now();
    this.bus.push(Route.Background, {
      kind: "delegate.query",
      contextId,
      timestampMs: queryStartedMs,
      query: userText,
    });

    try {
      for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
        grounded = false;
        try {
          const pending = this.opts.runStore
            ? await Promise.resolve(this.opts.runStore.takePending(contextId))
            : null;
          const resuming = pending !== null;
          const turn: ReasonerTurn = pending
            ? { userText, messages: this.history, signal, resume: { runId: pending.runId, data: userText } }
            : { userText, messages: this.history, signal };

          let finishReason: "stop" | "tool" | "length" | null = null;

          for await (const part of withStreamIdleTimeout(this.reasoner.stream(turn), this.timeoutMs, signal)) {
            if (signal.aborted) return;
            switch (part.type) {
              case "text-delta":
                reply += part.text;
                emittedDelta = true;
                this.bus.push(Route.Main, {
                  kind: "llm.delta",
                  contextId,
                  timestampMs: Date.now(),
                  text: part.text,
                });
                break;
              case "tool-call":
                this.bus.push(Route.Main, {
                  kind: "llm.tool_call",
                  contextId,
                  timestampMs: Date.now(),
                  toolId: part.toolId,
                  toolName: part.toolName,
                  toolArgs: part.args,
                });
                break;
              case "tool-result":
                grounded = true;
                this.bus.push(Route.Main, {
                  kind: "llm.tool_result",
                  contextId,
                  timestampMs: Date.now(),
                  toolId: part.toolId,
                  toolName: part.toolName,
                  result: part.result,
                });
                break;
              case "error":
                throw part.cause;
              case "finish":
                this.recordFinishReason(contextId, "llm.finish_reason", part.reason);
                finishReason = part.reason;
                break;
              case "suspended": {
                if (part.prompt && !emittedDelta) {
                  this.bus.push(Route.Main, {
                    kind: "llm.delta",
                    contextId,
                    timestampMs: Date.now(),
                    text: part.prompt,
                  });
                  reply += part.prompt;
                }
                if (signal.aborted) return;
                this.bus.push(Route.Main, {
                  kind: "llm.done",
                  contextId,
                  timestampMs: Date.now(),
                  text: reply,
                });
                this.rememberTurn(userText, reply, contextId);
                this.bus.push(Route.Background, {
                  kind: "reasoning.suspended",
                  contextId,
                  timestampMs: Date.now(),
                  runId: part.runId,
                  prompt: part.prompt,
                  payload: part.payload,
                });
                if (this.opts.runStore) {
                  await Promise.resolve(this.opts.runStore.save(contextId, part.runId));
                }
                committed = true;
                return;
              }
            }
          }

          // A non-"stop" finish must fail the TURN, never the call (L2). Killing the
          // session on a token-cap or unfinished-tool-loop hangs up the caller
          // mid-conversation. `length` = token cap: the streamed reply is truncated
          // but usable, so accept it and continue (fall through to llm.done). Any
          // other non-"stop" reason (tool loop ended, null) = fail the turn
          // recoverably — the caller hears the graceful fallback, the call stays up.
          if (finishReason !== "stop" && finishReason !== "length") {
            if (signal.aborted) return;
            this.bus.push(Route.Critical, {
              kind: "llm.error",
              contextId,
              timestampMs: Date.now(),
              component: "bridge" as const,
              category: ErrorCategory.InternalFault,
              cause: new Error(`AI SDK turn ended on finishReason "${finishReason ?? "null"}"`),
              isRecoverable: true,
            });
            return;
          }
          if (finishReason === "length") {
            this.bus.push(Route.Background, {
              kind: "metric.conversation",
              contextId,
              timestampMs: Date.now(),
              name: "llm.finish_length_truncated",
              value: "1",
            });
          }

          // Interrupted as generation finished — the interrupt handler owns the history
          // for this turn (spoken prefix); don't commit the full reply or emit llm.done.
          if (signal.aborted) return;

          const answeredMs = Date.now();
          this.bus.push(Route.Main, {
            kind: "llm.done",
            contextId,
            timestampMs: answeredMs,
            text: reply,
          });
          // G2 observability: the reasoner produced the turn's final answer.
          this.bus.push(Route.Background, {
            kind: "delegate.result",
            contextId,
            timestampMs: answeredMs,
            query: userText,
            answer: reply,
            durationMs: answeredMs - queryStartedMs,
            grounded,
          });
          this.rememberTurn(userText, reply, contextId);
          if (this.opts.runStore && resuming) {
            await Promise.resolve(this.opts.runStore.discard(contextId));
          }
          committed = true;
          return;
        } catch (err) {
          if (signal.aborted) return;
          const category = categorizeLlmError(err);
          const recoverable = isRecoverable(category);
          if (!recoverable || emittedDelta || attempt >= this.retryConfig.maxAttempts) {
            this.bus.push(Route.Critical, {
              kind: "llm.error",
              contextId,
              timestampMs: Date.now(),
              component: "bridge" as const,
              category,
              cause: err instanceof Error ? err : new Error(String(err)),
              isRecoverable: recoverable,
            });
            return;
          }

          this.bus.push(Route.Background, {
            kind: "metric.conversation",
            contextId,
            timestampMs: Date.now(),
            name: "llm.retry",
            value: String(attempt + 1),
          });
          await waitForRetryDelay(attempt, this.retryConfig, signal);
        }
      }
    } finally {
      if (this.activeGeneration?.controller === controller) {
        this.activeGeneration = null;
      }
      if (!committed) this.clearTurnState(contextId);
    }
  }

  private recordFinishReason(
    contextId: string,
    name: string,
    finishReason: "stop" | "tool" | "length",
  ): void {
    this.bus?.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: Date.now(),
      name,
      value: finishReason,
    });
  }

  async close(): Promise<void> {
    this.activeGeneration?.controller.abort();
    this.activeGeneration = null;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.spokenByContext.clear();
    this.turnUserText.clear();
    this.assistantMsgByContext.clear();
    this.wordTimestampsByContext.clear();
    this.playedOutMsByContext.clear();
    this.bus = null;
  }

  private rememberTurn(userText: string, assistantText: string, contextId: string): void {
    const assistantMsg = { role: "assistant" as const, content: assistantText };
    this.history.push({ role: "user", content: userText }, assistantMsg);
    this.assistantMsgByContext.set(contextId, assistantMsg);
    this.trimHistory();
    this.persistHistory();
  }

  /** G4: persist the bounded history snapshot, best-effort off the hot path. */
  private persistHistory(): void {
    const store = this.opts.sessionStore;
    const sessionId = this.opts.sessionId;
    if (!store || !sessionId) return;
    try {
      void Promise.resolve(store.save(sessionId, this.history.map((message) => ({ ...message })))).catch(
        () => undefined,
      );
    } catch {
      /* persistence must never fail the turn */
    }
  }

  /**
   * G25: compute the spoken prefix — the assistant text the user actually heard before
   * the barge-in. Uses word timestamps + playout position when available (exact at word
   * boundaries), otherwise falls back to the accumulated text sent to TTS (approximate).
   */
  private computeSpokenPrefix(contextId: string): string {
    const words = this.wordTimestampsByContext.get(contextId);
    const playedOutMs = this.playedOutMsByContext.get(contextId);
    if (words && words.length > 0 && playedOutMs !== undefined && playedOutMs > 0) {
      const heard = words.filter((w) => w.endMs <= playedOutMs);
      return heard.map((w) => w.word).join(" ");
    }
    return (this.spokenByContext.get(contextId) ?? "").trim();
  }

  /**
   * Barge-in: rewrite the interrupted turn's history to what the user actually HEARD,
   * not the full generated reply. Precision ladder (G25):
   *   1. Word timestamps + playout position → exact word-boundary prefix.
   *   2. Fallback: text sent to TTS — approximate (may include unplayed audio since
   *      TTS streams faster than realtime; headless/browser paths have no playout clock).
   * If the turn was committed (generation done before barge-in), truncates in place.
   * If mid-generation (not yet committed), records what was sent. Either way the user
   * utterance is preserved: neither divergent nor amnesiac.
   */
  private commitInterruptedHistory(contextId: string): void {
    const spoken = this.computeSpokenPrefix(contextId);
    const existing = this.assistantMsgByContext.get(contextId);
    if (existing) {
      if (spoken) {
        existing.content = spoken;
      } else {
        const idx = this.history.indexOf(existing);
        if (idx >= 0) this.history.splice(idx, 1);
      }
    } else {
      const userText = this.turnUserText.get(contextId);
      if (userText !== undefined) {
        this.history.push({ role: "user", content: userText });
        if (spoken) this.history.push({ role: "assistant", content: spoken });
        this.trimHistory();
      }
    }
    this.bus?.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: Date.now(),
      name: "llm.history_truncated_to_spoken",
      value: String(spoken.length),
    });
    this.persistHistory(); // G4: the durable snapshot reflects the heard prefix
    this.clearTurnState(contextId);
  }

  private trimHistory(): void {
    const maxMessages = this.maxHistoryTurns * 2;
    if (this.history.length > maxMessages) {
      this.history = this.history.slice(this.history.length - maxMessages);
    }
    // Drop tracked per-turn state that has aged out of the history window.
    for (const [ctx, msg] of this.assistantMsgByContext) {
      if (!this.history.includes(msg)) this.clearTurnState(ctx);
    }
  }

  private clearTurnState(contextId: string): void {
    this.spokenByContext.delete(contextId);
    this.turnUserText.delete(contextId);
    this.assistantMsgByContext.delete(contextId);
    this.wordTimestampsByContext.delete(contextId);
    this.playedOutMsByContext.delete(contextId);
  }
}


function readPositiveIntegerConfig(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

async function* withStreamIdleTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    const next = await nextWithTimeout(iterator, timeoutMs, signal);
    if (next.done === true) return;
    yield next.value;
  }
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("AI SDK stream aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      void iterator.return?.(undefined);
      reject(new Error(`AI SDK stream idle timeout after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      void iterator.return?.(undefined);
      reject(new Error("AI SDK stream aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (next) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolve(next);
      },
      (err: unknown) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
