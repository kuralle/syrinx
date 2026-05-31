// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — AI SDK Bridge Plugin
//
// Bridges the PipelineBus to Vercel AI SDK for LLM inference.
// Listens for EOS turn completions, calls LLM, pushes deltas + done + tool calls
// into the bus. Handles LLM interrupts via AbortController.

import type { PipelineBus } from "@asyncdot/voice";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  streamText,
  stepCountIs,
  type FinishReason,
  type ModelMessage,
  type TextStreamPart,
  type ToolChoice,
  type ToolSet,
} from "ai";
import {
  Route,
  type VoicePlugin,
  type PluginConfig,
  type TtsWordTimestamp,
  requireStringConfig,
  categorizeLlmError,
  isRecoverable,
  readRetryConfig,
  waitForRetryDelay,
  type RetryConfig,
} from "@asyncdot/voice";

export type AISDKBridgeTools = ToolSet;
export type AISDKStreamFactory = (request: {
  userText: string;
  signal: AbortSignal;
  messages: ModelMessage[];
}) => AsyncGenerator<TextStreamPart<ToolSet>>;

export class AISDKBridgePlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private apiKey: string = "";
  private model: string = "gemini-2.5-flash";
  private systemPrompt: string = "You are a helpful voice assistant.";
  private tools: AISDKBridgeTools | undefined;
  private toolChoice: ToolChoice<ToolSet> | undefined;
  private temperature: number = 0.4;
  private maxOutputTokens: number = 256;
  private maxSteps: number = 3;
  private timeoutMs: number = 30_000;
  private maxHistoryTurns: number = 12;
  private history: ModelMessage[] = [];
  private abortController: AbortController | null = null;
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
  // Present only when a paced transport (telnyx/twilio/smartpbx) is wired; headless/
  // browser paths have no tts.playout_progress and fall back to spokenByContext.
  private playedOutMsByContext = new Map<string, number>();

  constructor(private readonly streamFactory?: AISDKStreamFactory) {}

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.model = (config["model"] as string) ?? "gemini-2.5-flash";
    this.systemPrompt = (config["system_prompt"] as string) ?? "You are a helpful voice assistant.";
    this.tools = readToolsConfig(config["tools"]);
    this.toolChoice = readToolChoiceConfig(config["tool_choice"]);
    this.temperature = readNumberConfig(config["temperature"], 0.4);
    this.maxOutputTokens = readPositiveIntegerConfig(config["max_output_tokens"], 256);
    this.maxSteps = readPositiveIntegerConfig(config["max_steps"], this.tools === undefined ? 1 : 3);
    this.timeoutMs = readPositiveIntegerConfig(config["timeout_ms"], 30_000);
    this.maxHistoryTurns = readPositiveIntegerConfig(config["max_history_turns"], 12);
    this.retryConfig = readRetryConfig(config);

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
        this.abortController?.abort();
        this.abortController = null;
        this.commitInterruptedHistory((pkt as { contextId: string }).contextId);
      }),
    );
  }

  private async processTurn(userText: string, contextId: string): Promise<void> {
    if (!this.bus) return;

    this.turnUserText.set(contextId, userText);

    // Handlers are concurrent, so a new turn can begin while a prior generation is
    // still in flight. Supersede it: abort the previous controller before starting.
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let reply = "";
    let emittedDelta = false;

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
      try {
        let finishReason: FinishReason | null = null;
        let rawFinishReason: string | undefined;
        for await (const part of withStreamIdleTimeout(this.streamResponse(userText, signal), this.timeoutMs, signal)) {
          if (signal.aborted) return;
          if (part.type === "text-delta") {
            reply += part.text;
            emittedDelta = true;

            this.bus.push(Route.Main, {
              kind: "llm.delta",
              contextId,
              timestampMs: Date.now(),
              text: part.text,
            });
          } else if (part.type === "tool-call") {
            this.bus.push(Route.Main, {
              kind: "llm.tool_call",
              contextId,
              timestampMs: Date.now(),
              toolId: part.toolCallId,
              toolName: part.toolName,
              toolArgs: toRecord(part.input),
            });
          } else if (part.type === "tool-result") {
            this.bus.push(Route.Main, {
              kind: "llm.tool_result",
              contextId,
              timestampMs: Date.now(),
              toolId: part.toolCallId,
              toolName: part.toolName,
              result: stringifyToolOutput(part.output),
            });
          } else if (part.type === "tool-error") {
            throw part.error instanceof Error ? part.error : new Error(`Tool ${part.toolName} failed`);
          } else if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          } else if (part.type === "finish-step") {
            this.recordFinishReason(contextId, "llm.finish_step_reason", part.finishReason, part.rawFinishReason);
            if (part.finishReason === "error" || part.finishReason === "content-filter") {
              throw new Error(`AI SDK provider step failed: ${formatFinishReason(part.finishReason, part.rawFinishReason)}`);
            }
          } else if (part.type === "finish") {
            finishReason = part.finishReason;
            rawFinishReason = part.rawFinishReason;
            this.recordFinishReason(contextId, "llm.finish_reason", part.finishReason, part.rawFinishReason);
          }
        }

        validateFinalFinishReason(finishReason, rawFinishReason);

        // Interrupted as generation finished — the interrupt handler owns the history
        // for this turn (spoken prefix); don't commit the full reply or emit llm.done.
        if (signal.aborted) return;

        this.bus.push(Route.Main, {
          kind: "llm.done",
          contextId,
          timestampMs: Date.now(),
          text: reply,
        });
        this.rememberTurn(userText, reply, contextId);
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
  }

  private async *streamResponse(userText: string, signal: AbortSignal): AsyncGenerator<TextStreamPart<ToolSet>> {
    const messages: ModelMessage[] = [...this.history, { role: "user", content: userText }];
    if (this.streamFactory) {
      yield* this.streamFactory({ userText, signal, messages });
      return;
    }

    const google = createGoogleGenerativeAI({ apiKey: this.apiKey });
    const result = streamText({
      model: google(this.model),
      system: this.systemPrompt,
      messages,
      tools: this.tools,
      toolChoice: this.toolChoice,
      temperature: this.temperature,
      maxOutputTokens: this.maxOutputTokens,
      maxRetries: 0,
      abortSignal: signal,
      timeout: this.timeoutMs,
      stopWhen: stepCountIs(this.maxSteps),
    });

    for await (const part of result.fullStream) {
      yield part;
    }
  }

  private recordFinishReason(
    contextId: string,
    name: string,
    finishReason: FinishReason,
    rawFinishReason: string | undefined,
  ): void {
    this.bus?.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: Date.now(),
      name,
      value: rawFinishReason ? `${finishReason}:${rawFinishReason}` : finishReason,
    });
  }

  async close(): Promise<void> {
    this.abortController?.abort();
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

function validateFinalFinishReason(finishReason: FinishReason | null, rawFinishReason: string | undefined): void {
  if (finishReason === null) {
    throw new Error("AI SDK stream ended without a provider finish reason");
  }
  if (finishReason === "length") {
    throw new Error(`AI SDK provider reached token limit before completing: ${formatFinishReason(finishReason, rawFinishReason)}`);
  }
  if (finishReason !== "stop") {
    throw new Error(`AI SDK provider did not complete normally: ${formatFinishReason(finishReason, rawFinishReason)}`);
  }
}

function formatFinishReason(finishReason: FinishReason, rawFinishReason: string | undefined): string {
  return rawFinishReason ? `${finishReason} (${rawFinishReason})` : finishReason;
}

function readToolsConfig(value: unknown): AISDKBridgeTools | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Plugin config key tools must be an AI SDK ToolSet object");
  }
  return value as AISDKBridgeTools;
}

function readToolChoiceConfig(value: unknown): ToolChoice<ToolSet> | undefined {
  if (value === undefined) return undefined;
  return value as ToolChoice<ToolSet>;
}

function readNumberConfig(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readPositiveIntegerConfig(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringifyToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

async function* withStreamIdleTimeout<T>(
  stream: AsyncGenerator<T>,
  timeoutMs: number,
  signal: AbortSignal,
): AsyncGenerator<T> {
  for (;;) {
    const next = await nextWithTimeout(stream, timeoutMs, signal);
    if (next.done === true) return;
    yield next.value;
  }
}

async function nextWithTimeout<T>(
  stream: AsyncGenerator<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("AI SDK stream aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      void stream.return(undefined);
      reject(new Error(`AI SDK stream idle timeout after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      void stream.return(undefined);
      reject(new Error("AI SDK stream aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stream.next().then(
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
