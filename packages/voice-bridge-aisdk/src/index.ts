// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — AI SDK Bridge Plugin
//
// Bridges the PipelineBus to Vercel AI SDK for LLM inference.
// Listens for EOS turn completions, calls LLM, pushes deltas + done + tool calls
// into the bus. Handles LLM interrupts via AbortController.

import type { PipelineBus } from "@asyncdot/voice";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText, stepCountIs, type TextStreamPart, type ToolSet } from "ai";
import {
  Route,
  type VoicePlugin,
  type PluginConfig,
  requireStringConfig,
  categorizeLlmError,
  isRecoverable,
  readRetryConfig,
  waitForRetryDelay,
  type RetryConfig,
} from "@asyncdot/voice";

export type AISDKBridgeTools = ToolSet;

export class AISDKBridgePlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private apiKey: string = "";
  private model: string = "gemini-2.5-flash";
  private systemPrompt: string = "You are a helpful voice assistant.";
  private tools: AISDKBridgeTools | undefined;
  private temperature: number = 0.4;
  private maxOutputTokens: number = 256;
  private maxSteps: number = 3;
  private timeoutMs: number = 30_000;
  private abortController: AbortController | null = null;
  private retryConfig: RetryConfig = readRetryConfig({});
  private disposers: Array<() => void> = [];

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.model = (config["model"] as string) ?? "gemini-2.5-flash";
    this.systemPrompt = (config["system_prompt"] as string) ?? "You are a helpful voice assistant.";
    this.tools = readToolsConfig(config["tools"]);
    this.temperature = readNumberConfig(config["temperature"], 0.4);
    this.maxOutputTokens = readPositiveIntegerConfig(config["max_output_tokens"], 256);
    this.maxSteps = readPositiveIntegerConfig(config["max_steps"], this.tools === undefined ? 1 : 3);
    this.timeoutMs = readPositiveIntegerConfig(config["timeout_ms"], 30_000);
    this.retryConfig = readRetryConfig(config);

    // Listen for EOS turn completions
    this.disposers.push(
      bus.on("eos.turn_complete", async (pkt: unknown) => {
        const eos = pkt as { text: string; contextId: string };
        await this.processTurn(eos.text, eos.contextId);
      }),

      // Listen for LLM interrupts
      bus.on("interrupt.llm", () => {
        this.abortController?.abort();
        this.abortController = null;
      }),
    );
  }

  private async processTurn(userText: string, contextId: string): Promise<void> {
    if (!this.bus) return;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let reply = "";
    let emittedDelta = false;

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
      try {
        for await (const part of this.streamResponse(userText, signal)) {
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
          } else if (part.type === "finish-step" && part.finishReason === "error") {
            throw new Error(`AI SDK provider step failed: ${part.rawFinishReason ?? "unknown finish reason"}`);
          } else if (part.type === "finish" && part.finishReason === "error") {
            throw new Error(`AI SDK provider failed: ${part.rawFinishReason ?? "unknown finish reason"}`);
          }
        }

        this.bus.push(Route.Main, {
          kind: "llm.done",
          contextId,
          timestampMs: Date.now(),
          text: reply,
        });
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
    const google = createGoogleGenerativeAI({ apiKey: this.apiKey });
    const result = streamText({
      model: google(this.model),
      system: this.systemPrompt,
      prompt: userText,
      tools: this.tools,
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

  async close(): Promise<void> {
    this.abortController?.abort();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.bus = null;
  }
}

function readToolsConfig(value: unknown): AISDKBridgeTools | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Plugin config key tools must be an AI SDK ToolSet object");
  }
  return value as AISDKBridgeTools;
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
