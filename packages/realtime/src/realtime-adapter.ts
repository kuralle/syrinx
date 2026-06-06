// SPDX-License-Identifier: MIT

export interface RealtimeAdapter {
  readonly caps: {
    readonly inputSampleRateHz: number;
    readonly outputSampleRateHz: number;
    readonly supportsConcurrentToolAudio: boolean;
    readonly supportsTruncate: boolean;
  };

  open(signal: AbortSignal): Promise<void>;
  sendAudio(pcm16: Uint8Array): void;
  cancelResponse(audioEndMs: number): void;
  injectToolResult(toolId: string, text: string): void;
  /** Close the provider socket and end the event stream. */
  close(): Promise<void>;
  readonly events: AsyncIterable<RealtimeEvent>;
}

export type RealtimeEvent =
  | { type: "audio"; pcm16: Uint8Array; sampleRateHz: number }
  | { type: "speech_started" }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "tool_call"; toolId: string; toolName: string; args: Record<string, unknown> }
  | { type: "response_started" }
  | { type: "response_done" }
  | { type: "error"; cause: Error; recoverable: boolean };
