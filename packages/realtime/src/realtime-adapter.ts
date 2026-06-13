// SPDX-License-Identifier: MIT

export interface RealtimeAdapter {
  readonly caps: {
    readonly inputSampleRateHz: number;
    readonly outputSampleRateHz: number;
    readonly supportsConcurrentToolAudio: boolean;
    readonly supportsTruncate: boolean;
    readonly emitsServerSpeechStarted: boolean;
  };

  open(signal: AbortSignal): Promise<void>;
  sendAudio(pcm16: Uint8Array): void;
  /**
   * Send a typed user turn to the front model and request a response. Optional: adapters whose
   * provider cannot accept text input omit it, and the bridge silently ignores typed turns for them.
   */
  sendText?(text: string): void;
  cancelResponse(audioEndMs: number): void;
  injectToolResult(toolId: string, text: string): void;
  /** Close the provider socket and end the event stream. */
  close(): Promise<void>;
  readonly events: AsyncIterable<RealtimeEvent>;
}

/**
 * A function tool advertised to the front model so it can decide when to delegate. Domain-neutral:
 * the caller (example/app) supplies these — the provider adapter never hardcodes any tool.
 */
export interface RealtimeToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool arguments. */
  readonly parameters: Record<string, unknown>;
}

export type RealtimeEvent =
  | { type: "audio"; pcm16: Uint8Array; sampleRateHz: number }
  | { type: "speech_started" }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "tool_call"; toolId: string; toolName: string; args: Record<string, unknown> }
  | { type: "response_started" }
  | { type: "response_done" }
  | { type: "error"; cause: Error; recoverable: boolean };
