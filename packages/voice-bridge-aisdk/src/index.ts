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
} from "@asyncdot/voice";

export class AISDKBridgePlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private model: string = "gemini-2.5-flash";
  private systemPrompt: string = "You are a helpful voice assistant.";
  private abortController: AbortController | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.model = (config["model"] as string) ?? "gemini-2.5-flash";
    this.systemPrompt = (config["system_prompt"] as string) ?? "You are a helpful voice assistant.";

    // Listen for EOS turn completions
    bus.on("eos.turn_complete", async (pkt: unknown) => {
      const eos = pkt as { text: string; contextId: string };
      await this.processTurn(eos.text, eos.contextId);
    });

    // Listen for LLM interrupts
    bus.on("interrupt.llm", () => {
      this.abortController?.abort();
      this.abortController = null;
    });
  }

  private async processTurn(userText: string, contextId: string): Promise<void> {
    if (!this.bus) return;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      // Use the AI SDK to stream tokens
      // Stub: in real implementation, imports ai-sdk and calls streamText()
      // For now, simulate streaming with a mock
      const reply = `Thanks for your message: "${userText}". How can I help?`;

      for (const word of reply.split(" ")) {
        if (signal.aborted) return;

        this.bus.push(Route.Main, {
          kind: "llm.delta",
          contextId,
          timestampMs: Date.now(),
          text: word + " ",
        });
        // Simulate token streaming delay
        await new Promise((r) => setTimeout(r, 10));
      }

      this.bus.push(Route.Main, {
        kind: "llm.done",
        contextId,
        timestampMs: Date.now(),
        text: reply,
      });
    } catch (err) {
      if (signal.aborted) return;
      const category = categorizeLlmError(err);
      this.bus.push(Route.Critical, {
        kind: "llm.error",
        contextId,
        timestampMs: Date.now(),
        component: "bridge" as const,
        category,
        cause: err instanceof Error ? err : new Error(String(err)),
        isRecoverable: isRecoverable(category),
      });
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.bus = null;
  }
}
