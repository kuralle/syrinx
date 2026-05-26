// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — AI SDK Bridge Plugin
//
// Bridges the PipelineBus to Vercel AI SDK for LLM inference.
// Listens for EOS turn completions, calls LLM, pushes deltas + done + tool calls
// into the bus. Handles LLM interrupts via AbortController.

import type { PipelineBus } from "@asyncdot/voice";
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

export class AISDKBridgePlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private apiKey: string = "";
  private model: string = "gemini-2.5-flash";
  private systemPrompt: string = "You are a helpful voice assistant.";
  private abortController: AbortController | null = null;
  private retryConfig: RetryConfig = readRetryConfig({});
  private disposers: Array<() => void> = [];

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.model = (config["model"] as string) ?? "gemini-2.5-flash";
    this.systemPrompt = (config["system_prompt"] as string) ?? "You are a helpful voice assistant.";
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
        for await (const delta of this.streamGemini(userText, signal)) {
          if (signal.aborted) return;
          reply += delta;
          emittedDelta = true;

          this.bus.push(Route.Main, {
            kind: "llm.delta",
            contextId,
            timestampMs: Date.now(),
            text: delta,
          });
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

  private async *streamGemini(userText: string, signal: AbortSignal): AsyncGenerator<string> {
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent`,
    );
    url.searchParams.set("alt", "sse");
    url.searchParams.set("key", this.apiKey);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: this.systemPrompt }] },
          { role: "model", parts: [{ text: "Understood." }] },
          { role: "user", parts: [{ text: userText }] },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 256,
        },
      }),
    });

    if (!response.ok || !response.body) {
      const err = new Error(`Gemini HTTP ${response.status}`);
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data);
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text === "string" && text.length > 0) {
          yield text;
        }
      }
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.bus = null;
  }
}
