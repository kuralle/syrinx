// SPDX-License-Identifier: MIT
//
// SessionRecord — a structured, bounded view of what happened in a voice session,
// assembled from the messages the server already sends. Every debugging surface
// (turn timeline, event log, metrics, fixture capture) reads this one shape, and a
// fixture is a SessionRecord trimmed to one turn.
//
// Deliberately dependency-free and DOM-free: this module is exported from the
// `/record` subpath so a Node consumer can import it without pulling AudioContext
// or the opus codec. Assembly is a pure reduction over messages — no sockets, no
// timers, no React — which is what makes every consumer testable against recorded
// fixtures instead of a live provider.

import type { SyrinxStudioMessage } from "./index.js";

/** Per-turn latency decomposition, from the `metrics` message. */
export interface TurnTimings {
  readonly speechEndMs?: number;
  readonly textReadyMs?: number;
  readonly firstAudioByteMs?: number;
  readonly firstAudioPlayedMs?: number;
  readonly lastAudioPlayedMs?: number;
  readonly sttMs?: number;
  readonly llmTTFTMs?: number;
  readonly ttsTTFBMs?: number;
  readonly e2eMs?: number;
}

/** Negotiated session parameters. Recorded so a replayed fixture cannot silently mislead. */
export interface SessionConfig {
  readonly wsUrl?: string;
  readonly sessionId?: string;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
  readonly encoding?: "pcm_s16le" | "opus";
  readonly binaryEnvelope?: string;
  readonly rawBinaryInput?: boolean;
  readonly resumeWindowMs?: number;
  /** Only present once the server exposes it; the timeline omits the marker rather than guessing. */
  readonly endpointingOwner?: string;
}

export interface ToolCall {
  readonly id?: string;
  readonly name?: string;
  readonly args?: unknown;
  readonly result?: unknown;
  /** `delayed` means it outlived the cue threshold — a slow tool, not a failed one. */
  readonly phase?: "started" | "delayed" | "complete" | "failed";
  readonly afterMs?: number;
}

export interface RecordedEvent {
  /** ms since the record started — comparable across turns. */
  readonly atMs: number;
  readonly message: SyrinxStudioMessage | { readonly type: string; readonly [k: string]: unknown };
}

export interface TurnRecord {
  readonly turnId: string;
  readonly startedAtMs: number;
  readonly events: readonly RecordedEvent[];
  /** Absent on runtimes that do not emit `metrics` — the Workers path does not. */
  readonly timings?: TurnTimings;
  readonly userTranscript?: string;
  /** Latest interim, cleared once the final arrives. */
  readonly userInterim?: string;
  readonly userConfidence?: number;
  readonly agentText: string;
  readonly toolCalls: readonly ToolCall[];
  readonly ttsAudioBytes: number;
  readonly interrupted?: { readonly atMs: number; readonly reason?: string };
  readonly errors: readonly { readonly atMs: number; readonly component?: string; readonly category?: string; readonly message: string }[];
  readonly complete: boolean;
  /** Non-zero when this turn's event list hit the cap. Surfaced, never silent. */
  readonly droppedEvents: number;
}

export interface SessionRecord {
  readonly config: SessionConfig;
  readonly turns: readonly TurnRecord[];
  /** Non-zero when oldest turns were evicted. Surfaced, never silent. */
  readonly droppedTurns: number;
  /** Messages that arrived before any turn existed, or with no turnId. */
  readonly sessionEvents: readonly RecordedEvent[];
}

export interface SessionRecordLimits {
  readonly maxTurns: number;
  readonly maxEventsPerTurn: number;
}

export const DEFAULT_LIMITS: SessionRecordLimits = { maxTurns: 50, maxEventsPerTurn: 500 };

export function emptySessionRecord(config: SessionConfig = {}): SessionRecord {
  return { config, turns: [], droppedTurns: 0, sessionEvents: [] };
}

// A message we do not recognise — the Cloudflare agents SDK sends `cf_agent_identity`
// and `cf_agent_mcp_servers` before `ready`, and future SDK versions will add more.
// These are retained in the event stream but must never affect turn assembly.
type AnyMessage = SyrinxStudioMessage | { readonly type: string; readonly [k: string]: unknown };

const turnIdOf = (m: AnyMessage): string | undefined =>
  typeof (m as { turnId?: unknown }).turnId === "string" ? (m as { turnId: string }).turnId : undefined;

function newTurn(turnId: string, atMs: number): TurnRecord {
  return {
    turnId,
    startedAtMs: atMs,
    events: [],
    agentText: "",
    toolCalls: [],
    ttsAudioBytes: 0,
    errors: [],
    complete: false,
    droppedEvents: 0,
  };
}

function pushEvent(turn: TurnRecord, ev: RecordedEvent, limits: SessionRecordLimits): TurnRecord {
  if (turn.events.length < limits.maxEventsPerTurn) {
    return { ...turn, events: [...turn.events, ev] };
  }
  // Drop the oldest, keep the newest, and count what was lost.
  return { ...turn, events: [...turn.events.slice(1), ev], droppedEvents: turn.droppedEvents + 1 };
}

function upsertToolCall(calls: readonly ToolCall[], key: string | undefined, patch: Partial<ToolCall>): readonly ToolCall[] {
  // A later phase message carries fewer fields than an earlier one — `tool_call_complete`
  // has no `afterMs` and may have no `toolName`. Spreading those as explicit `undefined`
  // would erase what `tool_call_delayed`/`agent_tool_call` already established, so drop
  // undefined keys before merging.
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<ToolCall>;
  const i = key === undefined ? -1 : calls.findIndex((c) => c.id === key);
  if (i === -1) return [...calls, { ...defined, id: key }];
  const next = [...calls];
  next[i] = { ...next[i], ...defined };
  return next;
}

/**
 * Fold one message into the record. Pure: same inputs, same output, no side effects.
 *
 * `atMs` is the caller's clock (ms since the record started) rather than anything
 * read from the message, so the record stays deterministic under test.
 */
export function applyMessage(
  record: SessionRecord,
  message: AnyMessage,
  atMs: number,
  limits: SessionRecordLimits = DEFAULT_LIMITS,
): SessionRecord {
  const ev: RecordedEvent = { atMs, message };
  const type = typeof message?.type === "string" ? message.type : "";

  // `ready` carries the negotiated config and belongs to the session, not a turn.
  if (type === "ready") {
    const m = message as Extract<SyrinxStudioMessage, { type: "ready" }>;
    return {
      ...record,
      config: {
        ...record.config,
        sessionId: m.sessionId ?? record.config.sessionId,
        resumeWindowMs: m.resumeWindowMs ?? record.config.resumeWindowMs,
        inputSampleRateHz: m.audio?.inputSampleRateHz ?? record.config.inputSampleRateHz,
        outputSampleRateHz: m.audio?.outputSampleRateHz ?? record.config.outputSampleRateHz,
        encoding: m.audio?.encoding ?? record.config.encoding,
        binaryEnvelope: m.audio?.binaryEnvelope ?? record.config.binaryEnvelope,
        rawBinaryInput: m.audio?.rawBinaryInput ?? record.config.rawBinaryInput,
      },
      sessionEvents: [...record.sessionEvents, ev],
    };
  }

  const turnId = turnIdOf(message);
  // No turn to attribute this to — including every unknown type that carries no
  // turnId, e.g. the agents-SDK `cf_agent_*` messages. Retained, but inert.
  if (turnId === undefined) {
    return { ...record, sessionEvents: [...record.sessionEvents, ev] };
  }

  let turns = record.turns;
  let droppedTurns = record.droppedTurns;
  let current = turns.find((t) => t.turnId === turnId);
  if (!current) {
    // Out-of-order arrival is fine: a turn is created by whichever of its
    // messages lands first, not by a designated "start" message.
    current = newTurn(turnId, atMs);
    let appended = [...turns, current];
    if (appended.length > limits.maxTurns) {
      appended = appended.slice(appended.length - limits.maxTurns);
      droppedTurns += 1;
    }
    turns = appended;
  }

  let turn = pushEvent(current, ev, limits);

  switch (type) {
    case "stt_chunk":
      turn = { ...turn, userInterim: (message as { transcript: string }).transcript };
      break;
    case "stt_output": {
      const m = message as { transcript: string; confidence?: number };
      turn = { ...turn, userTranscript: m.transcript, userInterim: undefined, userConfidence: m.confidence };
      break;
    }
    case "agent_chunk":
      turn = { ...turn, agentText: turn.agentText + (message as { text: string }).text };
      break;
    case "agent_tool_call": {
      const m = message as { id?: string; name: string; args?: unknown };
      turn = { ...turn, toolCalls: upsertToolCall(turn.toolCalls, m.id, { name: m.name, args: m.args }) };
      break;
    }
    case "agent_tool_result": {
      const m = message as { id?: string; result?: unknown };
      turn = { ...turn, toolCalls: upsertToolCall(turn.toolCalls, m.id, { result: m.result }) };
      break;
    }
    case "tool_call_started":
    case "tool_call_delayed":
    case "tool_call_complete":
    case "tool_call_failed": {
      const m = message as { toolId?: string; toolName?: string; afterMs?: number };
      const phase = type.slice("tool_call_".length) as ToolCall["phase"];
      turn = {
        ...turn,
        toolCalls: upsertToolCall(turn.toolCalls, m.toolId, { name: m.toolName, phase, afterMs: m.afterMs }),
      };
      break;
    }
    case "tts_chunk":
      turn = { ...turn, ttsAudioBytes: turn.ttsAudioBytes + ((message as { byteLength?: number }).byteLength ?? 0) };
      break;
    case "agent_interrupted":
      turn = { ...turn, interrupted: { atMs, reason: (message as { reason?: string }).reason } };
      break;
    case "turn_complete":
      turn = {
        ...turn,
        complete: true,
        userTranscript: (message as { transcript?: string }).transcript ?? turn.userTranscript,
      };
      break;
    case "metrics": {
      const { type: _t, turnId: _i, correlationId: _c, ...timings } = message as Record<string, unknown>;
      turn = { ...turn, timings: timings as TurnTimings };
      break;
    }
    case "error": {
      const m = message as { component?: string; category?: string; message: string };
      turn = {
        ...turn,
        errors: [...turn.errors, { atMs, component: m.component, category: m.category, message: m.message }],
      };
      break;
    }
    default:
      // Unknown or non-mutating type (speech_started, tts_end, audio_clear, …):
      // already recorded in `events`; nothing further to derive.
      break;
  }

  return { ...record, turns: turns.map((t) => (t.turnId === turnId ? turn : t)), droppedTurns };
}

/** Fold a whole message stream. Equivalent to repeated `applyMessage`. */
export function buildSessionRecord(
  messages: readonly { readonly message: AnyMessage; readonly atMs: number }[],
  config: SessionConfig = {},
  limits: SessionRecordLimits = DEFAULT_LIMITS,
): SessionRecord {
  return messages.reduce(
    (rec, { message, atMs }) => applyMessage(rec, message, atMs, limits),
    emptySessionRecord(config),
  );
}
