// SPDX-License-Identifier: MIT

import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  Route,
  SYRINX_AUDIO_ENVELOPE_NAME,
  decodeSyrinxAudioEnvelope,
  encodeSyrinxAudioEnvelope,
  hasSyrinxAudioEnvelope,
  type InterruptTtsPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type UserAudioReceivedPacket,
  type UserTextReceivedPacket,
  type VoiceAgentSession,
  type VoiceAgentSessionEvents,
} from "@asyncdot/voice";
import { pcm16BytesToSamples, pcm16SamplesToBytes, resamplePcm16 } from "@asyncdot/voice/audio";
import { closeWebSocketWithFallback } from "./websocket-close.js";
import { isRecord, parseJsonRecord, optionalString, requiredString } from "./json-message.js";
import { createRoutedWebSocketServer } from "./websocket-upgrade.js";
import { runWebSocketConnection, type TransportAdapter, type TransportHostConfig } from "./transport-host.js";
import {
  decodeStrictBase64,
  nonNegativeInteger,
  positiveInteger,
  rawDataToText,
} from "./transport-helpers.js";

export * from "./twilio.js";
export * from "./telnyx.js";
export * from "./smartpbx.js";

export interface VoiceWebSocketServerOptions {
  readonly server?: HttpServer;
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  readonly createSession: (request: IncomingMessage) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly sessionId?: (request: IncomingMessage) => string;
  readonly contextId?: () => string;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
  readonly heartbeatIntervalMs?: number;
  readonly startupTimeoutMs?: number;
  readonly maxSessionDurationMs?: number;
  readonly maxBufferedAmountBytes?: number;
  readonly maxInboundMessageBytes?: number;
  readonly resumeWindowMs?: number;
  /**
   * Raw binary inbound PCM16 lacks turn, sample-rate, sequence, and duration
   * metadata. Keep disabled for production clients; use JSON audio frames or
   * the Syrinx binary envelope instead. Set true only for explicitly managed
   * legacy/embedded clients that send PCM at `inputSampleRateHz`.
   */
  readonly rawBinaryInput?: boolean;
  /**
   * Assistant audio binary frames are wrapped in the Syrinx binary audio
   * envelope by default. Set false only for raw-PCM websocket clients.
   * Inbound binary frames may use the envelope regardless.
   */
  readonly binaryAudioEnvelope?: boolean;
}

export interface VoiceWebSocketServer {
  readonly httpServer: HttpServer;
  readonly wsServer: WebSocketServer;
  address(): ReturnType<HttpServer["address"]>;
  close(): Promise<void>;
}

type ClientMessage =
  | { readonly type: "text"; readonly text: string; readonly contextId?: string }
  | {
      readonly type: "audio";
      readonly audio: string;
      readonly contextId?: string;
      readonly sampleRateHz: number;
      readonly sequence?: number;
    }
  | { readonly type: "ping" };

interface ManagedSession {
  readonly id: string;
  readonly session: VoiceAgentSession;
  currentContextId: string;
  readonly contextSampleRates: Map<string, number>;
  readonly inputSequence: AudioSequenceState;
  closeTimer: ReturnType<typeof setTimeout> | null;
  connectionCount: number;
}

interface AudioSequenceState {
  lastSequence: number | null;
}

interface BrowserConnectionState {
  managed: ManagedSession | null;
  readonly initialContextId: string;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SESSION_DURATION_MS = 30 * 60_000;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESUME_WINDOW_MS = 15_000;

export async function createVoiceWebSocketServer(
  options: VoiceWebSocketServerOptions,
): Promise<VoiceWebSocketServer> {
  const ownsHttpServer = !options.server;
  const httpServer = options.server ?? createServer();
  const routedWebSocket = createRoutedWebSocketServer(httpServer, options.path ?? "/ws");
  const wsServer = routedWebSocket.wsServer;
  const sessions = new Map<string, ManagedSession>();
  const sessionIdFn = options.sessionId ?? defaultSessionId;
  const contextIdFn = options.contextId ?? defaultContextId;
  const inputSampleRateHz = positiveInteger(options.inputSampleRateHz) ?? 16000;
  const outputSampleRateHz = positiveInteger(options.outputSampleRateHz) ?? 16000;
  const rawBinaryInput = options.rawBinaryInput ?? false;
  const binaryAudioEnvelope = options.binaryAudioEnvelope ?? true;
  const resumeWindowMs = nonNegativeInteger(options.resumeWindowMs) ?? DEFAULT_RESUME_WINDOW_MS;
  const hostConfig: TransportHostConfig = {
    heartbeatIntervalMs: nonNegativeInteger(options.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    startupTimeoutMs: nonNegativeInteger(options.startupTimeoutMs) ?? DEFAULT_STARTUP_TIMEOUT_MS,
    maxSessionDurationMs: nonNegativeInteger(options.maxSessionDurationMs) ?? DEFAULT_MAX_SESSION_DURATION_MS,
    maxBufferedAmountBytes: positiveInteger(options.maxBufferedAmountBytes) ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
    maxInboundMessageBytes: positiveInteger(options.maxInboundMessageBytes) ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES,
  };

  const adapter: TransportAdapter<BrowserConnectionState> = {
    createState: () => ({
      managed: null,
      initialContextId: contextIdFn(),
    }),

    async acquireSession({ request, state, shouldAbort, onSessionCreated }) {
      const requestedSessionId = sanitizeSessionId(sessionIdFromRequest(request) ?? sessionIdFn(request));
      const existing = sessions.get(requestedSessionId);
      if (existing) {
        const resumed = existing.connectionCount > 0 || existing.closeTimer !== null;
        if (existing.closeTimer) {
          clearTimeout(existing.closeTimer);
          existing.closeTimer = null;
        }
        existing.connectionCount += 1;
        state.managed = existing;
        return { session: existing.session, resumed };
      }
      const sess = await options.createSession(request);
      onSessionCreated(sess);
      if (shouldAbort()) {
        await sess.close().catch(() => undefined);
        throw new Error("websocket session startup aborted");
      }
      await sess.start();
      if (shouldAbort()) {
        await sess.close().catch(() => undefined);
        throw new Error("websocket session startup aborted");
      }
      const managed: ManagedSession = {
        id: requestedSessionId,
        session: sess,
        currentContextId: state.initialContextId,
        contextSampleRates: new Map(),
        inputSequence: { lastSequence: null },
        closeTimer: null,
        connectionCount: 1,
      };
      sessions.set(requestedSessionId, managed);
      state.managed = managed;
      return { session: sess, resumed: false };
    },

    wireSession(session, socket, state, disposers) {
      wireBrowserSessionEvents(session, socket, disposers, outputSampleRateHz, binaryAudioEnvelope, hostConfig.maxBufferedAmountBytes);
      return () => undefined;
    },

    processMessage(data, isBinary, session, state) {
      if (!state.managed) return;
      const managed = state.managed;
      const nextContextId = handleClientMessage(
        session,
        data,
        isBinary,
        managed.currentContextId,
        contextIdFn,
        inputSampleRateHz,
        rawBinaryInput,
        managed.contextSampleRates,
        managed.inputSequence,
      );
      managed.currentContextId = nextContextId;
    },

    onDisconnect(_session, state, { maxSessionTimedOut }) {
      if (state.managed) {
        state.managed.connectionCount = Math.max(0, state.managed.connectionCount - 1);
        scheduleManagedSessionClose(state.managed, sessions, maxSessionTimedOut ? 0 : resumeWindowMs);
      }
    },

    onStartupTimeout(_state, session) {
      void session.close().catch(() => undefined);
    },

    sendReady(session, socket, state, resumed, config) {
      const managed = state.managed;
      if (!managed) return;
      sendJson(socket, {
        type: "ready",
        sessionId: managed.id,
        turnId: managed.currentContextId,
        resumed,
        resumeWindowMs,
        maxSessionDurationMs: config.maxSessionDurationMs,
        audio: {
          inputSampleRateHz,
          outputSampleRateHz,
          encoding: "pcm_s16le",
          channels: 1,
          binaryEnvelope: binaryAudioEnvelope ? SYRINX_AUDIO_ENVELOPE_NAME : undefined,
          rawBinaryInput,
          maxInboundMessageBytes: config.maxInboundMessageBytes,
        },
      }, config.maxBufferedAmountBytes);
    },

    sendError(socket, _state, message) {
      sendJson(socket, {
        type: "error",
        component: "transport",
        category: "invalid_input",
        message,
      }, hostConfig.maxBufferedAmountBytes);
    },

    sendStartupError(socket, _state, err, isTimeout) {
      sendJson(socket, {
        type: "error",
        component: "session",
        category: isTimeout ? "startup_timeout" : "initialization",
        message: err instanceof Error ? err.message : String(err),
      }, hostConfig.maxBufferedAmountBytes);
    },

    onMaxSessionTimeout(socket, _state) {
      sendJson(socket, {
        type: "error",
        component: "transport",
        category: "session_timeout",
        message: "Websocket max session duration exceeded",
      }, hostConfig.maxBufferedAmountBytes);
    },
  };

  wsServer.on("connection", (socket, request) => {
    void runWebSocketConnection(socket, request, hostConfig, adapter);
  });

  if (ownsHttpServer || typeof options.port === "number") {
    await new Promise<void>((resolveListen, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(options.port ?? 0, options.host, () => {
        httpServer.off("error", reject);
        resolveListen();
      });
    });
  }

  return {
    httpServer,
    wsServer,
    address: () => httpServer.address(),
    close: async () => {
      for (const client of wsServer.clients) client.terminate();
      for (const managed of sessions.values()) {
        if (managed.closeTimer) clearTimeout(managed.closeTimer);
        await managed.session.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolveClose) => { wsServer.close(() => resolveClose()); });
      routedWebSocket.detach();
      if (ownsHttpServer || typeof options.port === "number") {
        await new Promise<void>((resolveClose) => { httpServer.close(() => resolveClose()); });
      }
    },
  };
}

function scheduleManagedSessionClose(
  managed: ManagedSession,
  sessions: Map<string, ManagedSession>,
  resumeWindowMs: number,
): void {
  if (managed.connectionCount > 0 || managed.closeTimer) return;
  if (resumeWindowMs <= 0) {
    sessions.delete(managed.id);
    void managed.session.close().catch(() => undefined);
    return;
  }
  managed.closeTimer = setTimeout(() => {
    managed.closeTimer = null;
    if (managed.connectionCount > 0) return;
    sessions.delete(managed.id);
    void managed.session.close().catch(() => undefined);
  }, resumeWindowMs);
}

function wireBrowserSessionEvents(
  session: VoiceAgentSession,
  socket: WebSocket,
  disposers: Array<() => void>,
  outputSampleRateHz: number,
  binaryAudioEnvelope: boolean,
  maxBufferedAmountBytes: number,
): void {
  const ttsSequences = new Map<string, number>();
  const interruptedContextIds = new Set<string>();

  const onSession = <K extends keyof VoiceAgentSessionEvents>(
    event: K,
    handler: VoiceAgentSessionEvents[K],
  ): void => {
    session.on(event, handler);
    disposers.push(() => session.off(event, handler));
  };

  onSession("user_started_speaking", (event) => {
    sendJson(socket, { type: "speech_started", turnId: event.turnId }, maxBufferedAmountBytes);
  });
  onSession("user_stopped_speaking", (event) => {
    sendJson(socket, { type: "speech_ended", turnId: event.turnId }, maxBufferedAmountBytes);
  });
  onSession("user_input_partial", (event) => {
    sendJson(socket, { type: "stt_chunk", turnId: event.turnId, transcript: event.text }, maxBufferedAmountBytes);
  });
  onSession("user_input_final", (event) => {
    sendJson(socket, { type: "stt_output", turnId: event.turnId, transcript: event.text, confidence: event.confidence }, maxBufferedAmountBytes);
  });
  onSession("agent_text_delta", (event) => {
    sendJson(socket, { type: "agent_chunk", turnId: event.turnId, text: event.delta }, maxBufferedAmountBytes);
  });
  onSession("agent_tool_call", (event) => {
    sendJson(socket, { type: "agent_tool_call", turnId: event.turnId, id: event.id, name: event.name, args: event.args }, maxBufferedAmountBytes);
  });
  onSession("agent_tool_result", (event) => {
    sendJson(socket, { type: "agent_tool_result", turnId: event.turnId, id: event.id, result: event.result }, maxBufferedAmountBytes);
  });
  onSession("agent_finished", (event) => {
    sendJson(socket, { type: "agent_end", turnId: event.turnId }, maxBufferedAmountBytes);
  });
  onSession("error", (event) => {
    sendJson(socket, {
      type: "error",
      component: event.stage,
      category: event.category,
      message: event.message,
    }, maxBufferedAmountBytes);
  });

  disposers.push(
    session.bus.on("interrupt.tts", (pkt) => {
      const interrupt = pkt as InterruptTtsPacket;
      interruptedContextIds.add(interrupt.contextId);
      ttsSequences.delete(interrupt.contextId);
      sendJson(socket, { type: "audio_clear", turnId: interrupt.contextId, reason: "barge_in" }, maxBufferedAmountBytes);
      sendJson(socket, { type: "agent_interrupted", turnId: interrupt.contextId, reason: "barge_in" }, maxBufferedAmountBytes);
    }),
    session.bus.on("tts.audio", (pkt) => {
      const audioPacket = pkt as TextToSpeechAudioPacket;
      if (interruptedContextIds.has(audioPacket.contextId)) return;
      const sourceSampleRateHz = requireTtsAudioSampleRate(audioPacket.sampleRateHz);
      const audio = resampleAudioBytes(audioPacket.audio, sourceSampleRateHz, outputSampleRateHz);
      if (socket.readyState !== WebSocket.OPEN) {
        session.bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId: audioPacket.contextId,
          timestampMs: Date.now(),
          name: "websocket.send_after_close",
          value: "1",
        });
        return;
      }
      const sequence = (ttsSequences.get(audioPacket.contextId) ?? 0) + 1;
      ttsSequences.set(audioPacket.contextId, sequence);
      sendJson(socket, {
        type: "tts_chunk",
        turnId: audioPacket.contextId,
        sequence,
        sampleRateHz: outputSampleRateHz,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: audio.byteLength,
        durationMs: pcm16DurationMs(audio, outputSampleRateHz),
      }, maxBufferedAmountBytes);
      sendSocketData(socket, binaryAudioEnvelope
        ? Buffer.from(encodeSyrinxAudioEnvelope({
            type: "audio",
            contextId: audioPacket.contextId,
            sequence,
            sampleRateHz: outputSampleRateHz,
            encoding: "pcm_s16le",
            channels: 1,
            byteLength: audio.byteLength,
            durationMs: pcm16DurationMs(audio, outputSampleRateHz),
          }, audio))
        : Buffer.from(audio), maxBufferedAmountBytes);
    }),
    session.bus.on("tts.end", (pkt) => {
      const end = pkt as TextToSpeechEndPacket;
      if (interruptedContextIds.has(end.contextId)) return;
      ttsSequences.delete(end.contextId);
      if (socket.readyState !== WebSocket.OPEN) {
        session.bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId: end.contextId,
          timestampMs: Date.now(),
          name: "websocket.send_after_close",
          value: "1",
        });
        return;
      }
      sendJson(socket, { type: "tts_end", turnId: end.contextId }, maxBufferedAmountBytes);
    }),
  );
}

function handleClientMessage(
  session: VoiceAgentSession,
  data: RawData,
  isBinary: boolean,
  currentContextId: string,
  contextId: () => string,
  inputSampleRateHz: number,
  rawBinaryInput: boolean,
  contextSampleRates: Map<string, number>,
  inputSequence: AudioSequenceState,
): string {
  if (isBinary) {
    const binaryAudio = decodeBinaryAudioMessage(rawDataToBytes(data), inputSampleRateHz, rawBinaryInput);
    const nextContextId = binaryAudio.contextId ?? currentContextId;
    if (nextContextId !== currentContextId) {
      pushTurnChange(session, nextContextId, currentContextId, "websocket_binary_audio_turn");
    }
    rememberContextSampleRate(contextSampleRates, nextContextId, binaryAudio.sampleRateHz);
    rememberInputSequence(session, inputSequence, nextContextId, binaryAudio.sequence);
    const audio = resampleAudioBytes(binaryAudio.audio, binaryAudio.sampleRateHz, inputSampleRateHz);
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: nextContextId,
      timestampMs: Date.now(),
      audio,
    } satisfies UserAudioReceivedPacket);
    return nextContextId;
  }

  const message = parseClientMessage(parseJsonRecord(rawDataToText(data), "Websocket JSON message"));
  if (message.type === "ping") return currentContextId;
  if (message.type === "text") {
    const nextContextId = message.contextId ?? contextId();
    if (nextContextId !== currentContextId) {
      pushTurnChange(session, nextContextId, currentContextId, "websocket_text_turn");
    }
    session.bus.push(Route.Main, {
      kind: "user.text_received",
      contextId: nextContextId,
      timestampMs: Date.now(),
      text: message.text,
    } satisfies UserTextReceivedPacket);
    return nextContextId;
  }
  if (message.type === "audio") {
    const nextContextId = message.contextId ?? currentContextId;
    if (nextContextId !== currentContextId) {
      pushTurnChange(session, nextContextId, currentContextId, "websocket_audio_turn");
    }
    const sourceSampleRateHz = requiredJsonAudioSampleRate(message.sampleRateHz);
    rememberContextSampleRate(contextSampleRates, nextContextId, sourceSampleRateHz);
    rememberInputSequence(session, inputSequence, nextContextId, optionalSequence(message.sequence));
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: nextContextId,
      timestampMs: Date.now(),
      audio: resampleAudioBytes(decodeStrictBase64(message.audio, "audio"), sourceSampleRateHz, inputSampleRateHz),
    } satisfies UserAudioReceivedPacket);
    return nextContextId;
  }
  throw new Error("Unsupported client message type");
}

function parseClientMessage(value: unknown): ClientMessage {
  if (!isRecord(value)) throw new Error("Websocket JSON message must be an object");
  const type = value.type;
  if (type === "ping") return { type };
  if (type === "text") {
    return {
      type,
      text: requiredString(value.text, "Websocket JSON text"),
      contextId: optionalContextId(value.contextId),
    };
  }
  if (type === "audio") {
    return {
      type,
      audio: requiredString(value.audio, "Websocket JSON audio"),
      contextId: optionalContextId(value.contextId),
      sampleRateHz: requiredJsonAudioSampleRate(value.sampleRateHz),
      sequence: optionalSequence(value.sequence),
    };
  }
  throw new Error("Unsupported client message type");
}

function optionalContextId(value: unknown): string | undefined {
  return optionalString(value, "Websocket JSON contextId");
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

function rememberContextSampleRate(
  contextSampleRates: Map<string, number>,
  contextId: string,
  sampleRateHz: number,
): void {
  const existing = contextSampleRates.get(contextId);
  if (existing !== undefined && existing !== sampleRateHz) {
    throw new Error(`Websocket audio sampleRateHz changed within context ${contextId}: ${existing} -> ${sampleRateHz}`);
  }
  contextSampleRates.set(contextId, sampleRateHz);
}

function pushTurnChange(
  session: VoiceAgentSession,
  contextId: string,
  previousContextId: string,
  reason: string,
): void {
  session.bus.push(Route.Main, {
    kind: "turn.change",
    contextId,
    previousContextId,
    reason,
    timestampMs: Date.now(),
  });
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data));
  throw new Error("Unsupported binary message payload");
}

function decodeBinaryAudioMessage(
  data: Uint8Array,
  defaultSampleRateHz: number,
  rawBinaryInput: boolean,
): { readonly contextId?: string; readonly sampleRateHz: number; readonly sequence?: number; readonly audio: Uint8Array } {
  if (!hasSyrinxAudioEnvelope(data)) {
    if (!rawBinaryInput) {
      throw new Error(`Raw binary websocket audio is disabled; use ${SYRINX_AUDIO_ENVELOPE_NAME} or JSON audio frames`);
    }
    return { sampleRateHz: defaultSampleRateHz, audio: data };
  }
  const { header, audio } = decodeSyrinxAudioEnvelope(data);
  return {
    contextId: typeof header.contextId === "string" && header.contextId.length > 0 ? header.contextId : undefined,
    sampleRateHz: requirePositiveIntegerFromHeader(header.sampleRateHz) ?? defaultSampleRateHz,
    sequence: header.sequence,
    audio,
  };
}

function requirePositiveIntegerFromHeader(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function resampleAudioBytes(audio: Uint8Array, sourceSampleRateHz: number, targetSampleRateHz: number): Uint8Array {
  if (audio.byteLength % 2 !== 0) {
    throw new Error("PCM16 audio payload must contain an even number of bytes");
  }
  if (sourceSampleRateHz === targetSampleRateHz) return audio;
  const samples = pcm16BytesToSamples(audio);
  const resampled = resamplePcm16(samples, sourceSampleRateHz, targetSampleRateHz);
  return pcm16SamplesToBytes(resampled);
}

function pcm16DurationMs(audio: Uint8Array, sampleRateHz: number): number {
  if (sampleRateHz <= 0) return 0;
  return Math.round((audio.byteLength / 2 / sampleRateHz) * 1000);
}

function requireTtsAudioSampleRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("tts.audio sampleRateHz must be a positive integer");
  }
  return value;
}

function optionalSequence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Websocket audio sequence must be a non-negative integer");
  }
  return value;
}

function requiredJsonAudioSampleRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("JSON websocket audio sampleRateHz must be a positive integer");
  }
  return value;
}

function sessionIdFromRequest(request: IncomingMessage): string | null {
  const url = request.url;
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
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

function sendJson(socket: WebSocket, value: unknown, maxBufferedAmountBytes: number): void {
  sendSocketData(socket, JSON.stringify(value), maxBufferedAmountBytes);
}

function sendSocketData(socket: WebSocket, data: string | Buffer, maxBufferedAmountBytes: number): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount + outboundMessageByteLength(data) > maxBufferedAmountBytes) {
    closeWebSocketWithFallback(socket, 1013, "websocket send buffer exceeded");
    return;
  }
  socket.send(data);
}

function outboundMessageByteLength(data: string | Buffer): number {
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
}

function defaultContextId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
