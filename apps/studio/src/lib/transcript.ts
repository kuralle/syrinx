import type { SyrinxStudioMessage } from "@kuralle-syrinx/browser-client";

export type TranscriptRole = "user" | "assistant";

export interface TranscriptEntry {
  readonly id: string;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly turnId?: string;
  readonly interim?: boolean;
}

export interface TranscriptState {
  readonly entries: readonly TranscriptEntry[];
  readonly interimUser?: string;
  readonly streamingAssistant?: {
    readonly turnId?: string;
    readonly text: string;
  };
}

export const initialTranscriptState: TranscriptState = {
  entries: [],
};

export function reduceTranscriptState(
  state: TranscriptState,
  message: SyrinxStudioMessage,
): TranscriptState {
  switch (message.type) {
    case "stt_chunk":
      return {
        ...state,
        interimUser: message.transcript,
      };
    case "stt_output": {
      const entries = state.entries.filter((entry) => !entry.interim);
      // Coalesce finalized STT segments of the same turn into ONE user bubble. Deepgram emits
      // several is_final segments per utterance (same turnId); without this each becomes a duplicate.
      const turnId = message.turnId;
      let lastUserIdx = -1;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i]!.role === "user") {
          if (turnId !== undefined && entries[i]!.turnId === turnId) lastUserIdx = i;
          break;
        }
      }
      const incoming = message.transcript.trim();
      if (lastUserIdx >= 0) {
        const existing = entries[lastUserIdx]!.text;
        const merged = incoming.includes(existing)
          ? incoming
          : existing.includes(incoming)
            ? existing
            : `${existing} ${incoming}`.trim();
        const next = [...entries];
        next[lastUserIdx] = { ...next[lastUserIdx]!, text: merged };
        return { entries: next, interimUser: undefined, streamingAssistant: state.streamingAssistant };
      }
      return {
        entries: [
          ...entries,
          {
            id: `user-${turnId ?? String(entries.length)}`,
            role: "user",
            text: incoming,
            turnId,
          },
        ],
        interimUser: undefined,
        streamingAssistant: state.streamingAssistant,
      };
    }
    case "agent_chunk": {
      const prior =
        state.streamingAssistant?.turnId === message.turnId
          ? (state.streamingAssistant?.text ?? "")
          : "";
      return {
        ...state,
        interimUser: state.interimUser,
        streamingAssistant: {
          turnId: message.turnId,
          text: prior + message.text,
        },
      };
    }
    case "agent_end": {
      if (!state.streamingAssistant?.text.trim()) {
        return { ...state, streamingAssistant: undefined };
      }
      const turnId = message.turnId ?? state.streamingAssistant.turnId;
      const id = `assistant-${turnId ?? String(state.entries.length)}`;
      return {
        entries: [
          ...state.entries,
          {
            id,
            role: "assistant",
            text: state.streamingAssistant.text,
            turnId,
          },
        ],
        interimUser: state.interimUser,
        streamingAssistant: undefined,
      };
    }
    default:
      return state;
  }
}

export function transcriptLines(state: TranscriptState): readonly TranscriptEntry[] {
  const lines = [...state.entries];
  if (state.interimUser?.trim()) {
    lines.push({
      id: "interim-user",
      role: "user",
      text: state.interimUser,
      interim: true,
    });
  }
  if (state.streamingAssistant?.text) {
    lines.push({
      id: "streaming-assistant",
      role: "assistant",
      text: state.streamingAssistant.text,
      turnId: state.streamingAssistant.turnId,
      interim: true,
    });
  }
  return lines;
}
