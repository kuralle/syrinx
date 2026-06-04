// SPDX-License-Identifier: MIT

import {
  Route,
  SYRINX_AUDIO_ENVELOPE_NAME,
  encodeSyrinxAudioEnvelope,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type UserAudioReceivedPacket,
  type UserTextReceivedPacket,
  type VoiceAgentSession,
  type VoiceAgentSessionEvents,
} from "@asyncdot/voice";
import { TimerScheduler, type Scheduler } from "@asyncdot/voice";
import {
  createWorkersInboundSocket,
  type WorkersDurableObjectWebSocketContext,
  type WorkersInboundSocketController,
} from "@asyncdot/voice-ws/workers";
import type { ManagedSocket, SocketData } from "@asyncdot/voice-ws";
import {
  type AudioSequenceState,
  type ManagedSession,
  type SessionStore,
} from "./session-store.js";

/**
 * Sink for per-conversation audio recording. The edge taps inbound caller audio
 * and outbound TTS audio and hands raw PCM16 frames to this sink; the concrete
 * implementation (e.g. an R2-backed recorder in the Workers host) decides where
 * and how to persist. Kept runtime-agnostic here — no storage types leak into
 * the transport layer.
 */
export interface EdgeRecorder {
  onUserAudio(contextId: string, audio: Uint8Array, sampleRateHz: number): void;
  onAssistantAudio(contextId: string, audio: Uint8Array, sampleRateHz: number): void;
  finalize(meta: { sessionId: string; closedAtMs: number }): void | Promise<void>;
}

export interface VoiceEdgeWebSocketOptions {
  readonly createSession: (request: Request) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly recorder?: EdgeRecorder;
  readonly sessionId?: (request: Request) => string;
  readonly contextId?: () => string;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
  readonly startupTimeoutMs?: number;
  readonly maxSessionDurationMs?: number;
  readonly maxInboundMessageBytes?: number;
  readonly resumeWindowMs?: number;
  /**
   * Heartbeat cadence. While a connection is open the edge re-arms a scheduler
   * task at this interval; on the Workers DO scheduler that alarm keeps the
   * Durable Object from being evicted mid-call (the equivalent of Cloudflare
   * agents' `keepAlive()` lease), and it is where idle/stale connections are
   * detected. 0 disables the heartbeat.
   */
  readonly keepAliveIntervalMs?: number;
  /**
   * Close a connection that has sent no message within this window. Catches
   * half-open clients (network dropped with no close frame) that the standard
   * WebSocket cannot detect via a ping frame. 0 disables idle close.
   */
  readonly idleTimeoutMs?: number;
  readonly sessionStore: SessionStore;
  readonly scheduler?: Scheduler;
}

export interface VoiceEdgeWebSocketUpgrade {
  readonly response: Response;
  readonly controller?: WorkersInboundSocketController;
}

type ClientMessage =
  | { readonly type: "text"; readonly text: string; readonly contextId?: string }
  | { readonly type: "audio"; readonly audio: string; readonly contextId?: string; readonly sampleRateHz: number; readonly sequence?: number }
  | { readonly type: "client_interrupt"; readonly assistantContextId?: string; readonly contextId?: string }
  | { readonly type: "ping" };

interface EdgeConnectionState {
  managed: ManagedSession | null;
  readonly initialContextId: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SESSION_DURATION_MS = 30 * 60_000;
const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESUME_WINDOW_MS = 15_000;
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_KEY = "voice.edge.keep_alive";

export function createVoiceEdgeWebSocketResponse(
  request: Request,
  options: VoiceEdgeWebSocketOptions,
  ctx?: WorkersDurableObjectWebSocketContext,
): Response {
  return createVoiceEdgeWebSocketUpgrade(request, options, ctx).response;
}

export function createVoiceEdgeWebSocketUpgrade(
  request: Request,
  options: VoiceEdgeWebSocketOptions,
  ctx?: WorkersDurableObjectWebSocketContext,
): VoiceEdgeWebSocketUpgrade {
  const inbound = createWorkersInboundSocket(ctx);
  void runVoiceEdgeWebSocketConnection(inbound.socket, request, options);
  return { response: inbound.response, controller: inbound.controller };
}

export async function runVoiceEdgeWebSocketConnection(
  socket: ManagedSocket,
  request: Request,
  options: VoiceEdgeWebSocketOptions,
): Promise<void> {
  const scheduler = options.scheduler ?? new TimerScheduler();
  const sessionIdFn = options.sessionId ?? defaultSessionId;
  const contextIdFn = options.contextId ?? defaultContextId;
  const inputSampleRateHz = positiveInteger(options.inputSampleRateHz) ?? 16000;
  const outputSampleRateHz = positiveInteger(options.outputSampleRateHz) ?? 16000;
  const startupTimeoutMs = nonNegativeInteger(options.startupTimeoutMs) ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const maxSessionDurationMs = nonNegativeInteger(options.maxSessionDurationMs) ?? DEFAULT_MAX_SESSION_DURATION_MS;
  const maxInboundMessageBytes = positiveInteger(options.maxInboundMessageBytes) ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES;
  const resumeWindowMs = nonNegativeInteger(options.resumeWindowMs) ?? DEFAULT_RESUME_WINDOW_MS;
  const keepAliveIntervalMs = nonNegativeInteger(options.keepAliveIntervalMs) ?? DEFAULT_KEEP_ALIVE_INTERVAL_MS;
  const idleTimeoutMs = nonNegativeInteger(options.idleTimeoutMs) ?? DEFAULT_IDLE_TIMEOUT_MS;
  const state: EdgeConnectionState = {
    managed: null,
    initialContextId: contextIdFn(),
  };
  const disposers: Array<() => void> = [];
  const pendingMessages: Array<{ data: SocketData; isBinary: boolean; byteLength: number }> = [];
  let pendingMessageBytes = 0;
  let ready = false;
  let closed = false;
  let maxSessionTimedOut = false;
  let lastClientMessageMs = Date.now();
  let session: VoiceAgentSession | null = null;

  const sendError = (message: string): void => {
    sendJson(socket, {
      type: "error",
      component: "transport",
      category: "invalid_input",
      message,
    });
  };

  const processMessage = (data: SocketData, isBinary: boolean): void => {
    if (!session || !state.managed) return;
    const managed = state.managed;
    options.sessionStore.update(managed.id, (stored) => {
      stored.currentContextId = handleClientMessage(
        session!,
        data,
        isBinary,
        stored.currentContextId,
        contextIdFn,
        inputSampleRateHz,
        stored.inputSequence,
      );
    });
  };

  socket.onMessage((data, isBinary) => {
    try {
      lastClientMessageMs = Date.now();
      const byteLength = socketDataByteLength(data);
      if (byteLength > maxInboundMessageBytes) {
        sendError(`Websocket message exceeds maxInboundMessageBytes (${String(maxInboundMessageBytes)})`);
        socket.dispose();
        return;
      }
      if (!ready) {
        pendingMessageBytes += byteLength;
        if (pendingMessageBytes > maxInboundMessageBytes) {
          sendError(`Pending websocket input exceeds maxInboundMessageBytes (${String(maxInboundMessageBytes)}) before session ready`);
          socket.dispose();
          return;
        }
        pendingMessages.push({ data: cloneSocketData(data), isBinary, byteLength });
        return;
      }
      processMessage(data, isBinary);
    } catch (err) {
      sendError(err instanceof Error ? err.message : String(err));
    }
  });

  socket.onClose(() => {
    closed = true;
    for (const dispose of disposers.splice(0)) dispose();
    if (state.managed) {
      state.managed.connectionCount = Math.max(0, state.managed.connectionCount - 1);
      void options.sessionStore.release(state.managed.id, maxSessionTimedOut ? 0 : resumeWindowMs);
    }
    if (options.recorder) {
      void Promise.resolve(
        options.recorder.finalize({ sessionId: state.managed?.id ?? "unknown", closedAtMs: Date.now() }),
      ).catch(() => undefined);
    }
  });

  try {
    const requestedSessionId = sanitizeSessionId(sessionIdFromRequest(request) ?? sessionIdFn(request));
    const leased = await withScheduledTimeout(
      options.sessionStore.lease(requestedSessionId, async () => {
        const sess = await options.createSession(request);
        if (closed) {
          await sess.close().catch(() => undefined);
          throw new Error("websocket session startup aborted");
        }
        await sess.start();
        if (closed) {
          await sess.close().catch(() => undefined);
          throw new Error("websocket session startup aborted");
        }
        return {
          id: requestedSessionId,
          session: sess,
          currentContextId: state.initialContextId,
          contextSampleRates: new Map(),
          inputSequence: { lastSequence: null },
          turnMetricsTurns: new Map(),
          closeTimer: null,
          connectionCount: 1,
        };
      }),
      startupTimeoutMs,
      scheduler,
      "voice.edge.startup_timeout",
    );
    state.managed = leased.managed;
    session = leased.managed.session;
    if (closed) {
      await options.sessionStore.release(leased.managed.id, 0);
      return;
    }
    wireEdgeSessionEvents(session, socket, disposers, outputSampleRateHz, options.recorder);
    if (options.recorder) {
      const recorder = options.recorder;
      disposers.push(
        session.bus.on("user.audio_received", (pkt) => {
          const audio = pkt as UserAudioReceivedPacket;
          recorder.onUserAudio(audio.contextId, audio.audio, inputSampleRateHz);
        }),
      );
    }
    if (maxSessionDurationMs > 0) {
      scheduler.schedule("voice.edge.max_session_duration", maxSessionDurationMs, () => {
        maxSessionTimedOut = true;
        sendJson(socket, {
          type: "error",
          component: "transport",
          category: "session_timeout",
          message: "Websocket max session duration exceeded",
        });
        socket.dispose();
      });
      disposers.push(() => scheduler.cancel("voice.edge.max_session_duration"));
    }
    if (keepAliveIntervalMs > 0) {
      const heartbeat = (): void => {
        if (closed) return;
        if (idleTimeoutMs > 0 && Date.now() - lastClientMessageMs > idleTimeoutMs) {
          sendJson(socket, {
            type: "error",
            component: "transport",
            category: "idle_timeout",
            message: `Websocket idle for more than idleTimeoutMs (${String(idleTimeoutMs)})`,
          });
          socket.dispose();
          return;
        }
        // Re-arm: on the Workers DO scheduler this keeps the alarm (and thus the
        // Durable Object) alive while the client is active; on Node it is a plain
        // interval. Cancelled on close so an idle DO can be evicted.
        scheduler.schedule(KEEP_ALIVE_KEY, keepAliveIntervalMs, heartbeat);
      };
      scheduler.schedule(KEEP_ALIVE_KEY, keepAliveIntervalMs, heartbeat);
      disposers.push(() => scheduler.cancel(KEEP_ALIVE_KEY));
    }
    sendJson(socket, {
      type: "ready",
      sessionId: leased.managed.id,
      turnId: leased.managed.currentContextId,
      resumed: leased.resumed,
      resumeWindowMs,
      maxSessionDurationMs,
      audio: {
        inputSampleRateHz,
        outputSampleRateHz,
        encoding: "pcm_s16le",
        supportedInputCodecs: ["pcm_s16le"],
        channels: 1,
        binaryEnvelope: SYRINX_AUDIO_ENVELOPE_NAME,
        maxInboundMessageBytes,
      },
    });
    ready = true;
    for (const pending of pendingMessages.splice(0)) {
      pendingMessageBytes -= pending.byteLength;
      processMessage(pending.data, pending.isBinary);
    }
  } catch (err) {
    sendJson(socket, {
      type: "error",
      component: "session",
      category: "initialization",
      message: err instanceof Error ? err.message : String(err),
    });
    socket.dispose();
  }
}

function wireEdgeSessionEvents(
  session: VoiceAgentSession,
  socket: ManagedSocket,
  disposers: Array<() => void>,
  outputSampleRateHz: number,
  recorder?: EdgeRecorder,
): void {
  const onSession = <K extends keyof VoiceAgentSessionEvents>(
    event: K,
    handler: VoiceAgentSessionEvents[K],
  ): void => {
    session.on(event, handler);
    disposers.push(() => session.off(event, handler));
  };

  onSession("user_input_final", (event) => {
    sendJson(socket, { type: "stt_output", turnId: event.turnId, transcript: event.text, confidence: event.confidence });
  });
  onSession("agent_text_delta", (event) => {
    sendJson(socket, { type: "agent_chunk", turnId: event.turnId, text: event.delta });
  });
  onSession("agent_finished", (event) => {
    sendJson(socket, { type: "agent_end", turnId: event.turnId });
  });
  onSession("error", (event) => {
    sendJson(socket, { type: "error", component: event.stage, category: event.category, message: event.message });
  });

  disposers.push(
    session.bus.on("tts.audio", (pkt) => {
      const audio = pkt as TextToSpeechAudioPacket;
      const ttsSampleRate = requireTtsAudioSampleRate(audio.sampleRateHz) ?? outputSampleRateHz;
      recorder?.onAssistantAudio(audio.contextId, audio.audio, ttsSampleRate);
      sendJson(socket, {
        type: "tts_chunk",
        turnId: audio.contextId,
        sequence: 1,
        sampleRateHz: requireTtsAudioSampleRate(audio.sampleRateHz) ?? outputSampleRateHz,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: audio.audio.byteLength,
        durationMs: pcm16DurationMs(audio.audio, outputSampleRateHz),
      });
      socket.send(encodeSyrinxAudioEnvelope({
        type: "audio",
        contextId: audio.contextId,
        sequence: 1,
        sampleRateHz: requireTtsAudioSampleRate(audio.sampleRateHz) ?? outputSampleRateHz,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: audio.audio.byteLength,
        durationMs: pcm16DurationMs(audio.audio, outputSampleRateHz),
      }, audio.audio));
    }),
    session.bus.on("tts.end", (pkt) => {
      const end = pkt as TextToSpeechEndPacket;
      sendJson(socket, { type: "tts_end", turnId: end.contextId });
    }),
    session.bus.on("eos.turn_complete", (pkt) => {
      const turn = pkt as { contextId: string; text?: string };
      sendJson(socket, { type: "turn_complete", turnId: turn.contextId, transcript: turn.text ?? "" });
    }),
  );
}

function handleClientMessage(
  session: VoiceAgentSession,
  data: SocketData,
  isBinary: boolean,
  currentContextId: string,
  contextId: () => string,
  inputSampleRateHz: number,
  inputSequence: AudioSequenceState,
): string {
  if (isBinary) {
    const nextContextId = currentContextId;
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: nextContextId,
      timestampMs: Date.now(),
      audio: typeof data === "string" ? textEncoder.encode(data) : data,
    } satisfies UserAudioReceivedPacket);
    return nextContextId;
  }
  const message = parseClientMessage(JSON.parse(typeof data === "string" ? data : textDecoder.decode(data)));
  if (message.type === "ping") return currentContextId;
  if (message.type === "client_interrupt") {
    const interruptedContextId = message.assistantContextId ?? message.contextId ?? currentContextId;
    if (interruptedContextId) session.requestClientInterrupt(interruptedContextId);
    return currentContextId;
  }
  if (message.type === "text") {
    const nextContextId = message.contextId ?? contextId();
    session.bus.push(Route.Main, {
      kind: "turn.change",
      contextId: nextContextId,
      previousContextId: currentContextId,
      reason: "websocket_text_turn",
      timestampMs: Date.now(),
    });
    session.bus.push(Route.Main, {
      kind: "user.text_received",
      contextId: nextContextId,
      timestampMs: Date.now(),
      text: message.text,
    } satisfies UserTextReceivedPacket);
    return nextContextId;
  }
  const nextContextId = message.contextId ?? currentContextId;
  rememberInputSequence(session, inputSequence, nextContextId, message.sequence);
  session.bus.push(Route.Main, {
    kind: "user.audio_received",
    contextId: nextContextId,
    timestampMs: Date.now(),
    audio: decodeBase64(message.audio),
  } satisfies UserAudioReceivedPacket);
  return nextContextId;
}

function parseClientMessage(value: unknown): ClientMessage {
  if (!isRecord(value)) throw new Error("Websocket JSON message must be an object");
  if (value.type === "ping") return { type: "ping" };
  if (value.type === "client_interrupt") {
    return {
      type: "client_interrupt",
      assistantContextId: optionalString(value.assistantContextId),
      contextId: optionalString(value.contextId),
    };
  }
  if (value.type === "text") {
    const text = optionalString(value.text);
    if (!text) throw new Error("Websocket JSON text must be a non-empty string");
    return { type: "text", text, contextId: optionalString(value.contextId) };
  }
  if (value.type === "audio") {
    const audio = optionalString(value.audio);
    const sampleRateHz = positiveInteger(value.sampleRateHz);
    if (!audio) throw new Error("Websocket JSON audio must be a non-empty base64 string");
    if (!sampleRateHz) throw new Error("JSON websocket audio sampleRateHz must be a positive integer");
    return {
      type: "audio",
      audio,
      contextId: optionalString(value.contextId),
      sampleRateHz,
      sequence: nonNegativeInteger(value.sequence) ?? undefined,
    };
  }
  throw new Error("Unsupported client message type");
}

function rememberInputSequence(
  session: VoiceAgentSession,
  state: AudioSequenceState,
  contextId: string,
  sequence: number | undefined,
): void {
  if (sequence === undefined) return;
  const previous = state.lastSequence;
  if (previous !== null && sequence <= previous) {
    throw new Error(`Websocket audio sequence must increase monotonically: ${String(previous)} -> ${String(sequence)}`);
  }
  if (previous !== null && sequence > previous + 1) {
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: Date.now(),
      name: "websocket.audio_sequence_gap",
      value: JSON.stringify({ expected: previous + 1, actual: sequence, missed: sequence - previous - 1 }),
    });
  }
  state.lastSequence = sequence;
}

function sendJson(socket: ManagedSocket, value: unknown): void {
  if (!socket.isOpen) return;
  socket.send(JSON.stringify(value));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function decodeBase64(value: string): Uint8Array {
  const raw = globalThis.atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function socketDataByteLength(data: SocketData): number {
  return typeof data === "string" ? textEncoder.encode(data).byteLength : data.byteLength;
}

function cloneSocketData(data: SocketData): SocketData {
  return typeof data === "string" ? data : data.slice();
}

function sessionIdFromRequest(request: Request): string | null {
  try {
    const parsed = new URL(request.url);
    return parsed.searchParams.get("sessionId") ?? parsed.searchParams.get("session_id");
  } catch {
    return null;
  }
}

function sanitizeSessionId(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_.:-]{1,128}$/.test(trimmed)) return trimmed;
  return defaultSessionId();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function requireTtsAudioSampleRate(value: unknown): number | null {
  return positiveInteger(value);
}

function pcm16DurationMs(audio: Uint8Array, sampleRateHz: number): number {
  if (sampleRateHz <= 0) return 0;
  return Math.round((audio.byteLength / 2 / sampleRateHz) * 1000);
}

function defaultContextId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function withScheduledTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  scheduler: Scheduler,
  key: string,
): Promise<T> {
  if (timeoutMs <= 0) return await promise;
  let settled = false;
  return await new Promise<T>((resolve, reject) => {
    scheduler.schedule(key, timeoutMs, () => {
      if (settled) return;
      settled = true;
      reject(new Error(`websocket session startup exceeded ${String(timeoutMs)}ms`));
    });
    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        scheduler.cancel(key);
        resolve(value);
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        scheduler.cancel(key);
        reject(err);
      });
  });
}
