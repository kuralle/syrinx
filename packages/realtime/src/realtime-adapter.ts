// SPDX-License-Identifier: MIT

export interface RealtimeAdapter {
  readonly caps: {
    readonly inputSampleRateHz: number;
    readonly outputSampleRateHz: number;
    readonly supportsConcurrentToolAudio: boolean;
    readonly supportsTruncate: boolean;
    readonly emitsServerSpeechStarted: boolean;
    /**
     * G4: the provider resumes a prior session server-side from a handle (Gemini Live
     * `sessionResumption`). Absent/false → resuming requires the host to replay the
     * transcript (e.g. OpenAI `resumeHistory`). A native-resume provider must NOT also
     * be replayed — that would double-apply history (RFC bimodel-delegate-seam R6).
     */
    readonly supportsNativeResume?: boolean;
    /** The front model owns full-duplex interaction decisions (turn-taking, barge-in). When true,
     *  Syrinx's InteractionPolicy runs observe-only and does not drive its own turn/interrupt decisions
     *  (RFC InteractionPolicy REQ-4). Absent/false → Syrinx drives. No current adapter sets this. */
    readonly supportsFullDuplex?: boolean;
    /** The front emits its own backchannels ("mhmm"). When true, Syrinx suppresses its own backchannel
     *  cues (RFC InteractionPolicy REQ-4). Absent/false → Syrinx may emit. */
    readonly emitsBackchannel?: boolean;
    /** Half-cascade: provider can run text-only modality (`modalities:["text"]`) so Syrinx TTS
     *  drives speech from assistant transcript events. Absent/false → no text-only half-cascade. */
    readonly supportsTextOnlyModality?: boolean;
  };

  open(signal: AbortSignal): Promise<void>;
  sendAudio(pcm16: Uint8Array): void;
  /**
   * Send a typed user turn to the front model and request a response. Optional: adapters whose
   * provider cannot accept text input omit it, and the bridge silently ignores typed turns for them.
   */
  sendText?(text: string): void;
  /**
   * Commit any buffered user input and request a response. For Syrinx-OWNED turn detection
   * (provider server VAD disabled via turnDetection:null): the host calls this when its own
   * endpointing (InteractionPolicy / VAD) signals end-of-turn. Optional — adapters without
   * manual turn control omit it.
   */
  requestResponse?(): void;
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

/** A prior-conversation message replayed into a front model on resume (G4). */
export interface RealtimeResumeMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export type RealtimeEvent =
  | { type: "audio"; pcm16: Uint8Array; sampleRateHz: number }
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "tool_call"; toolId: string; toolName: string; args: Record<string, unknown> }
  | { type: "response_started" }
  | { type: "response_done" }
  // G4: a native-resume provider issued a fresh resumption handle — persist the
  // latest one and pass it back on reconnect (Gemini `sessionResumption`).
  | { type: "resumption_handle"; handle: string }
  | { type: "error"; cause: Error; recoverable: boolean };
