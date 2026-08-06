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
  type ReasonerMessage,
  type ReasonerSessionStore,
  type ReasonerTurn,
  type TtsWordTimestamp,
  type IncrementalUnitId,
  categorizeLlmError,
  isRecoverable,
  readRetryConfig,
  waitForRetryDelay,
  ErrorCategory,
  type RetryConfig,
  InMemoryIuLedger,
  type IuLedger,
  type TranscriptViews,
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

/**
 * Gate for a speculative draft's side effects. While unpromoted, every bus push
 * and history/store mutation is buffered; promotion replays them in order and
 * lets the still-running stream continue live. A discarded draft's buffer is
 * simply dropped — the generation was never observable.
 */
interface SpeculativeHold {
  buffered: Array<() => void>;
}

export class ReasoningBridge implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private timeoutMs: number = 30_000;
  private maxHistoryTurns: number = 12;
  private history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string }> = [];
  private readonly transientContextMessages = new Set<{
    role: "system";
    content: string;
  }>();
  private activeGeneration: { contextId: string; controller: AbortController } | null = null;
  // At most one speculative draft at a time; `hold` gates its side effects.
  private speculativeDraft: {
    contextId: string;
    userText: string;
    controller: AbortController;
    hold: SpeculativeHold;
    id: IncrementalUnitId;
  } | null = null;
  private iuLedger!: InMemoryIuLedger;
  private boundLedger: InMemoryIuLedger | null = null;
  /** When true, VoiceAgentSession owns segmentation writes on this ledger. */
  private sessionOwnsSegmentation = false;
  private transcriptViews: TranscriptViews | null = null;
  private readonly epochByContext = new Map<string, number>();
  private turnEpochCounter = 0;
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
      /**
       * Speculative generation (LiveKit preemptive-generation / Deepgram Flux
       * eager-EOT semantics): start the LLM on `eos.interim` with every side effect
       * held back; commit as-is when `eos.turn_complete` confirms the same
       * transcript, regenerate when it differs, discard on `eos.retracted`.
       * Parallelizes LLM TTFT with the endpoint-confirmation window. Opt-in:
       * unconfirmed endpoints cost extra LLM calls (Deepgram measures +50–70% at
       * eager thresholds 0.3–0.5). Drafts never consume a suspended-run pointer —
       * `runStore` resume stays confirmed-turn-only.
       *
       * **Only enable this with a confidence-gated eager endpointer (Deepgram Flux).**
       * Promotion requires `draft.userText === eos.text` — exact equality. Flux
       * guarantees the EndOfTurn transcript matches the preceding EagerEndOfTurn when
       * no TurnResumed intervened, so drafts promote. `PipecatEOSPlugin` instead pushes
       * `eos.interim` on EVERY non-empty STT interim, and each interim discards the prior
       * draft and starts a new call, so the surviving draft is built on an interim
       * transcript that rarely matches the final one.
       *
       * Measured live on smart-turn, one turn, university fixture:
       *   ON  — started 13, discarded 13, promoted 0; ttfa 1724ms, llmTtft 1269ms
       *   OFF — started  0, discarded  0, promoted 0; ttfa 1302ms, llmTtft 1025ms
       *
       * Thirteen wasted LLM calls, zero promotions, and latency got *worse*. The lever
       * is Flux-specific; on a per-interim endpointer it is pure cost.
       */
      speculative?: boolean;
    } = {},
  ) {
    if (this.opts.onResumeConflict === "replay") {
      throw new Error("onResumeConflict 'replay' not yet supported — use 'restart'");
    }
  }

  injectContext(text: string): void {
    const message = { role: "system" as const, content: text };
    this.history.push(message);
    this.transientContextMessages.add(message);
  }

  bindIuLedger(ledger: IuLedger): void {
    this.boundLedger = ledger as InMemoryIuLedger;
    this.sessionOwnsSegmentation = true;
  }

  bindTranscriptViews(views: TranscriptViews): void {
    this.transcriptViews = views;
  }

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    if (this.boundLedger) {
      this.iuLedger = this.boundLedger;
    } else {
      this.iuLedger = new InMemoryIuLedger((a) => {
        const detail =
          a.kind === "terminal_op"
            ? `${a.op} on ${a.state} IU`
            : `${a.op} on unknown IU`;
        this.bus?.push(Route.Background, {
          kind: "llm.error",
          contextId: a.id.contextId,
          timestampMs: Date.now(),
          component: "iu_ledger",
          category: ErrorCategory.InternalFault,
          cause: new Error(`iu_ledger anomaly: ${a.kind} ${detail}`),
          isRecoverable: true,
        });
      });
      this.sessionOwnsSegmentation = false;
    }
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
        // R2: a draft for this exact transcript is already generating (or done) —
        // promote it instead of paying a second LLM call. Flux guarantees the
        // EndOfTurn transcript matches the preceding EagerEndOfTurn when no
        // TurnResumed intervened, so commit-as-is is safe.
        const draft = this.speculativeDraft;
        if (
          draft &&
          draft.contextId === eos.contextId &&
          draft.userText === eos.text &&
          !draft.controller.signal.aborted &&
          (this.iuLedger.get(draft.id)?.state === "hypothesized" ||
            this.iuLedger.get(draft.id)?.state === "committed")
        ) {
          if (this.iuLedger.get(draft.id)?.state === "hypothesized") {
            this.iuLedger.commit(draft.id);
          }
          this.speculativeDraft = null;
          this.metric(eos.contextId, "speculative.draft_promoted");
          for (const flush of draft.hold.buffered.splice(0)) flush();
          return;
        }
        // Stale, mismatched, or failed draft: its speculation was wrong — drop it
        // and answer the confirmed transcript fresh.
        this.discardDraft();
        await this.processTurn(eos.text, eos.contextId);
      }, { concurrent: true }),

      bus.on("llm.done", () => {
        if (!this.sessionOwnsSegmentation || !this.transcriptViews) return;
        this.trimHistory();
        this.persistHistory();
      }),

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
        if (this.speculativeDraft?.contextId === contextId) this.discardDraft();
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

    if (this.opts.speculative) {
      this.disposers.push(
        bus.on("eos.interim", async (pkt: unknown) => {
          const interim = pkt as { text?: string; contextId: string };
          const text = (interim.text ?? "").trim();
          if (!text) return;
          await this.runDraft(text, interim.contextId);
        }, { concurrent: true }),
        bus.on("eos.retracted", (pkt: unknown) => {
          const contextId = (pkt as { contextId: string }).contextId;
          if (this.speculativeDraft?.contextId === contextId) this.discardDraft();
        }),
      );
    }
  }

  /** Start (or restart, if a newer eager endpoint supersedes) the speculative draft. */
  private async runDraft(userText: string, contextId: string): Promise<void> {
    this.discardDraft();
    this.metric(contextId, "speculative.draft_started");
    const id = this.iuIdFor(contextId);
    if (!this.sessionOwnsSegmentation || !this.iuLedger.get(id)) {
      this.iuLedger.add({ id, kind: "user_turn", state: "hypothesized" });
    }
    const controller = new AbortController();
    const hold: SpeculativeHold = { buffered: [] };
    this.speculativeDraft = { contextId, userText, controller, hold, id };
    await this.processTurn(userText, contextId, hold, controller, id);
  }

  private iuIdFor(contextId: string): IncrementalUnitId {
    let epoch = this.epochByContext.get(contextId);
    if (epoch === undefined) {
      epoch = ++this.turnEpochCounter;
      this.epochByContext.set(contextId, epoch);
    }
    return { contextId, iuId: contextId, epoch };
  }

  private assistantIuIdFor(contextId: string): IncrementalUnitId {
    let epoch = this.epochByContext.get(contextId);
    if (epoch === undefined) {
      epoch = ++this.turnEpochCounter;
      this.epochByContext.set(contextId, epoch);
    }
    return { contextId, iuId: `${contextId}#assistant`, epoch };
  }

  private discardDraft(): void {
    const draft = this.speculativeDraft;
    if (!draft) return;
    this.speculativeDraft = null;
    const committed = this.iuLedger.get(draft.id)?.state === "committed";
    if (!committed) {
      this.metric(draft.contextId, "speculative.draft_discarded");
      this.iuLedger.revoke(draft.id);
      draft.controller.abort();
    }
  }

  private metric(contextId: string, name: string, value = "1"): void {
    this.bus?.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: Date.now(),
      name,
      value,
    });
  }

  private async processTurn(
    userText: string,
    contextId: string,
    hold?: SpeculativeHold,
    presetController?: AbortController,
    iuId?: IncrementalUnitId,
  ): Promise<void> {
    if (!this.bus) return;

    this.turnUserText.set(contextId, userText);

    // Handlers are concurrent, so a new turn can begin while a prior generation is
    // still in flight. Supersede it: abort the previous controller before starting.
    this.activeGeneration?.controller.abort();
    const controller = presetController ?? new AbortController();
    this.activeGeneration = { contextId, controller };
    const aid = this.assistantIuIdFor(contextId);
    if (!this.sessionOwnsSegmentation || !this.iuLedger.get(aid)) {
      this.iuLedger.add({ id: aid, kind: "assistant_response", state: "hypothesized" });
    }
    const signal = controller.signal;

    // R2: while a speculative hold is unpromoted, every push/mutation buffers.
    // Packets are constructed eagerly (their timestamps are event time); only
    // delivery is deferred. Promotion replays in order, then later effects run live.
    const isBuffering = (): boolean =>
      hold !== undefined &&
      iuId !== undefined &&
      this.iuLedger.get(iuId)?.state !== "committed";
    const push = <T extends Parameters<PipelineBus["push"]>[1]>(route: Route, packet: T): void => {
      if (isBuffering()) {
        if ((packet as { kind?: string }).kind === "llm.error" && iuId) this.iuLedger.revoke(iuId);
        hold!.buffered.push(() => this.bus?.push(route, packet));
        return;
      }
      this.bus?.push(route, packet);
    };
    const defer = (fn: () => void): void => {
      if (isBuffering()) hold!.buffered.push(fn);
      else fn();
    };

    let reply = "";
    let emittedDelta = false;
    let committed = false;
    let grounded = false;
    let passStartedMs = 0;
    let passTtftRecorded = false;
    const recordPassTtft = (): void => {
      if (passTtftRecorded) return;
      passTtftRecorded = true;
      const firstOutputMs = Date.now();
      push(Route.Main, {
        kind: "metric.conversation",
        contextId,
        timestampMs: firstOutputMs,
        name: "llm.pass_ttft_ms",
        value: String(firstOutputMs - passStartedMs),
      });
    };

    // G2 observability: the turn's query is on its way to the reasoner (Background
    // route, droppable — RFC bimodel-delegate-seam R4). Cascade turns have no
    // front-model tool call, so toolId/toolName are absent.
    const queryStartedMs = Date.now();
    push(Route.Background, {
      kind: "delegate.query",
      contextId,
      timestampMs: queryStartedMs,
      query: userText,
    });

    try {
      for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
        grounded = false;
        passStartedMs = Date.now();
        passTtftRecorded = false;
        push(Route.Main, {
          kind: "metric.conversation",
          contextId,
          timestampMs: passStartedMs,
          name: "llm.call_started",
          value: "1",
        });
        try {
          // Drafts never consume a suspended-run pointer: takePending mutates the
          // store, and a retracted draft would silently lose the resume.
          const pending = this.opts.runStore && !hold
            ? await Promise.resolve(this.opts.runStore.takePending(contextId))
            : null;
          const resuming = pending !== null;
          const turn: ReasonerTurn = pending
            ? { userText, messages: this.reasonerMessages(contextId, userText), signal, resume: { runId: pending.runId, data: userText } }
            : { userText, messages: this.reasonerMessages(contextId, userText), signal };

          let finishReason: "stop" | "tool" | "length" | null = null;

          for await (const part of withStreamIdleTimeout(this.reasoner.stream(turn), this.timeoutMs, signal)) {
            if (signal.aborted) return;
            switch (part.type) {
              case "text-delta":
                reply += part.text;
                emittedDelta = true;
                recordPassTtft();
                push(Route.Main, {
                  kind: "llm.delta",
                  contextId,
                  timestampMs: Date.now(),
                  text: part.text,
                });
                break;
              case "tool-call":
                recordPassTtft();
                push(Route.Main, {
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
                push(Route.Main, {
                  kind: "llm.tool_result",
                  contextId,
                  timestampMs: Date.now(),
                  toolId: part.toolId,
                  toolName: part.toolName,
                  result: part.result,
                });
                passStartedMs = Date.now();
                passTtftRecorded = false;
                push(Route.Main, {
                  kind: "metric.conversation",
                  contextId,
                  timestampMs: passStartedMs,
                  name: "llm.call_started",
                  value: "1",
                });
                break;
              case "control":
                push(Route.Background, {
                  kind: "delegate.result",
                  contextId,
                  timestampMs: Date.now(),
                  query: userText,
                  answer: reply,
                  durationMs: Date.now() - queryStartedMs,
                  grounded,
                  control: {
                    name: part.name,
                    payload: part.payload,
                  },
                });
                break;
              case "blocked": {
                if (signal.aborted) return;
                const safeMessage = part.userFacingMessage;
                const blockedMs = Date.now();
                push(Route.Main, {
                  kind: "llm.delta",
                  contextId,
                  timestampMs: blockedMs,
                  text: safeMessage,
                });
                push(Route.Main, {
                  kind: "llm.done",
                  contextId,
                  timestampMs: blockedMs,
                  text: safeMessage,
                });
                push(Route.Background, {
                  kind: "delegate.result",
                  contextId,
                  timestampMs: blockedMs,
                  query: userText,
                  answer: safeMessage,
                  durationMs: blockedMs - queryStartedMs,
                  grounded,
                  blocked: {
                    userFacingMessage: safeMessage,
                    payload: part.payload,
                  },
                });
                defer(() => this.rememberTurn(userText, safeMessage, contextId));
                committed = true;
                return;
              }
              case "error":
                throw part.cause;
              case "finish":
                push(Route.Background, {
                  kind: "metric.conversation",
                  contextId,
                  timestampMs: Date.now(),
                  name: "llm.finish_reason",
                  value: part.reason,
                });
                // Record billable token usage — the field the bridge used to drop.
                // A turn with tool calls produces several finish parts; the session
                // accumulator sums them, so emit per-finish rather than once per turn.
                if (part.usage) {
                  push(Route.Background, {
                    kind: "usage.recorded",
                    contextId,
                    timestampMs: Date.now(),
                    stage: "llm",
                    ...part.usage,
                  });
                }
                finishReason = part.reason;
                break;
              case "suspended": {
                if (part.prompt && !emittedDelta) {
                  push(Route.Main, {
                    kind: "llm.delta",
                    contextId,
                    timestampMs: Date.now(),
                    text: part.prompt,
                  });
                  reply += part.prompt;
                }
                if (signal.aborted) return;
                push(Route.Main, {
                  kind: "llm.done",
                  contextId,
                  timestampMs: Date.now(),
                  text: reply,
                });
                defer(() => this.rememberTurn(userText, reply, contextId));
                push(Route.Background, {
                  kind: "reasoning.suspended",
                  contextId,
                  timestampMs: Date.now(),
                  runId: part.runId,
                  prompt: part.prompt,
                  payload: part.payload,
                });
                if (this.opts.runStore) {
                  const store = this.opts.runStore;
                  const runId = part.runId;
                  if (isBuffering()) {
                    hold!.buffered.push(() => void Promise.resolve(store.save(contextId, runId)).catch(() => undefined));
                  } else {
                    await Promise.resolve(store.save(contextId, runId));
                  }
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
            push(Route.Critical, {
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
            push(Route.Background, {
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
          push(Route.Main, {
            kind: "llm.done",
            contextId,
            timestampMs: answeredMs,
            text: reply,
          });
          // G2 observability: the reasoner produced the turn's final answer.
          push(Route.Background, {
            kind: "delegate.result",
            contextId,
            timestampMs: answeredMs,
            query: userText,
            answer: reply,
            durationMs: answeredMs - queryStartedMs,
            grounded,
          });
          defer(() => this.rememberTurn(userText, reply, contextId));
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
            push(Route.Critical, {
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

          push(Route.Background, {
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

  async close(): Promise<void> {
    this.discardDraft();
    this.activeGeneration?.controller.abort();
    this.activeGeneration = null;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.spokenByContext.clear();
    this.turnUserText.clear();
    this.assistantMsgByContext.clear();
    this.wordTimestampsByContext.clear();
    this.playedOutMsByContext.clear();
    this.transientContextMessages.clear();
    this.bus = null;
  }

  private rememberTurn(userText: string, assistantText: string, contextId: string): void {
    if (!this.sessionOwnsSegmentation || !this.transcriptViews) {
      const assistantMsg = { role: "assistant" as const, content: assistantText };
      this.history.push({ role: "user", content: userText }, assistantMsg);
      this.assistantMsgByContext.set(contextId, assistantMsg);
      if (!this.sessionOwnsSegmentation) {
        this.iuLedger.commit(this.assistantIuIdFor(contextId));
      }
      this.trimHistory();
      this.persistHistory();
      return;
    }
    if (!this.sessionOwnsSegmentation) {
      this.iuLedger.commit(this.assistantIuIdFor(contextId));
    }
  }

  private reasonerMessages(contextId: string, userText: string): readonly ReasonerMessage[] {
    if (this.sessionOwnsSegmentation && this.transcriptViews) {
      const system = this.history.filter((message) => message.role === "system");
      const priorFromLedger = this.transcriptViews
        .committedTranscript()
        .filter((message) => !message.iuId.startsWith(`${contextId}:`))
        .map((message) => ({
          role: message.role,
          content: message.text,
        }));
      if (priorFromLedger.length > 0) {
        return [...system, ...priorFromLedger];
      }
      const durable = this.history.filter(
        (message) => !this.transientContextMessages.has(message as { role: "system"; content: string }),
      );
      return [
        ...system,
        ...durable.filter((message) => !(message.role === "user" && message.content === userText)),
      ];
    }
    return this.history;
  }

  private persistedMessages(): readonly ReasonerMessage[] {
    if (this.sessionOwnsSegmentation && this.transcriptViews) {
      return this.transcriptViews.committedTranscript().map((message) => ({
        role: message.role,
        content: message.text,
      }));
    }
    return this.history.filter(
      (message) => !this.transientContextMessages.has(message as { role: "system"; content: string }),
    );
  }

  /** G4: persist the bounded history snapshot, best-effort off the hot path. */
  private persistHistory(): void {
    const store = this.opts.sessionStore;
    const sessionId = this.opts.sessionId;
    if (!store || !sessionId) return;
    try {
      void Promise.resolve(
        store.save(
          sessionId,
          this.persistedMessages().map((message) => ({ ...message })),
        ),
      ).catch(
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
    const aid = this.assistantIuIdFor(contextId);
    const ms = this.playedOutMsByContext.get(contextId);
    const prefix = { chars: spoken.length, ms };
    const assistantIu = this.iuLedger.get(aid);
    if (!this.sessionOwnsSegmentation) {
      if (assistantIu?.state === "hypothesized") {
        this.iuLedger.commit(aid, prefix);
      } else if (assistantIu?.state === "committed") {
        assistantIu.committedPrefix = prefix;
      }
    }
    if (this.sessionOwnsSegmentation && this.transcriptViews) {
      this.persistHistory();
      this.clearTurnState(contextId);
      this.bus?.push(Route.Background, {
        kind: "metric.conversation",
        contextId,
        timestampMs: Date.now(),
        name: "llm.history_truncated_to_spoken",
        value: String(spoken.length),
      });
      return;
    }
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
    for (const message of this.transientContextMessages) {
      if (!this.history.includes(message)) this.transientContextMessages.delete(message);
    }
  }

  private clearTurnState(contextId: string): void {
    const aid = this.assistantIuIdFor(contextId);
    if (!this.sessionOwnsSegmentation && this.iuLedger.get(aid)?.state === "hypothesized") {
      this.iuLedger.revoke(aid);
    }
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
