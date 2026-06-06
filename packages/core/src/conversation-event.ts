// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Conversation Event (Debug Stream)
//
// Normalized event type consumed by debugger UIs and the VoiceSessionRecorder.
// Every pipeline component emits these alongside their functional packets.
// Exposed as `session.debugEvents: ReadableStream<ConversationEvent>`.
//
// Design decision (per RFC Q3 resolution): events flow through the bus on
// the Background route. If Background saturates, drops are metric'd.

// =============================================================================
// Type
// =============================================================================

export interface ConversationEvent {
  /** Component that emitted the event: "vad", "stt", "eos", "llm", "tts", "tool", "session", "turn" */
  readonly component: string;
  /** Sub-type: "speech_started", "interim", "final", "delta", "first_audio", "call_started", etc. */
  readonly type: string;
  /** Arbitrary key-value payload. Always includes "context_id". */
  readonly data: Readonly<Record<string, string>>;
  /** Wall-clock time of the event in ms since epoch. */
  readonly timestampMs: number;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ReadableStream of ConversationEvents that is fed by a callback.
 * Returns [stream, push] — call push(event) to enqueue, consumers read from stream.
 */
export function createConversationEventStream(): [
  ReadableStream<ConversationEvent>,
  (event: ConversationEvent) => void,
] {
  let controller: ReadableStreamDefaultController<ConversationEvent> | null =
    null;

  const stream = new ReadableStream<ConversationEvent>({
    start(c) {
      controller = c;
    },
    cancel() {
      controller = null;
    },
  });

  const push = (event: ConversationEvent): void => {
    if (controller) {
      try {
        controller.enqueue(event);
      } catch {
        // Stream closed — drop
      }
    }
  };

  return [stream, push];
}
