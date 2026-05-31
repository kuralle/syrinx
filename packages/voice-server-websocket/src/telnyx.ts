// SPDX-License-Identifier: MIT

import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  Route,
  type InterruptTtsPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type VoiceAgentSession,
} from "@asyncdot/voice";
import {
  bigEndianPcm16BytesToSamples,
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
  pcm16BytesToSamples,
  pcm16SamplesToBytes,
  pcm16SamplesToBigEndianBytes,
  resamplePcm16,
} from "@asyncdot/voice/audio";
import { PacedPlayoutQueue, type PacedPlayoutFrame } from "./paced-playout.js";
import { PlayoutProgressEmitter } from "./playout-progress.js";
import { closeWebSocketWithFallback } from "./websocket-close.js";
import {
  optionalRecord,
  optionalString,
  optionalStringOrNumber,
  parseJsonRecord,
  requiredString,
} from "./json-message.js";
import {
  WebSocketStartupTimeoutError,
  startWebSocketHeartbeat,
  startWebSocketMaxSessionDuration,
  withWebSocketStartupTimeout,
} from "./websocket-lifecycle.js";
import { createRoutedWebSocketServer } from "./websocket-upgrade.js";

export interface TelnyxMediaStreamServerOptions {
  readonly server?: HttpServer;
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  readonly createSession: (request: IncomingMessage) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly contextId?: (start: TelnyxStartPayload) => string;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
  /** Must match the `stream_bidirectional_codec` selected when starting the Telnyx call stream. */
  readonly bidirectionalCodec?: "PCMU" | "L16";
  readonly outboundFrameDurationMs?: number;
  readonly maxQueuedOutputAudioMs?: number;
  readonly maxInboundReorderFrames?: number;
  readonly heartbeatIntervalMs?: number;
  readonly startupTimeoutMs?: number;
  readonly maxSessionDurationMs?: number;
  readonly maxBufferedAmountBytes?: number;
  readonly maxInboundMessageBytes?: number;
}

export interface TelnyxMediaStreamServer {
  readonly httpServer: HttpServer;
  readonly wsServer: WebSocketServer;
  address(): ReturnType<HttpServer["address"]>;
  close(): Promise<void>;
}

export interface TelnyxStartPayload {
  readonly stream_id?: string;
  readonly call_control_id?: string;
  readonly call_session_id?: string;
  readonly media_format?: {
    readonly encoding?: string;
    readonly sample_rate?: number | string;
    readonly channels?: number | string;
  };
}

interface TelnyxMediaMessage {
  readonly event?: string;
  readonly stream_id?: string;
  readonly sequence_number?: string;
  readonly start?: TelnyxStartPayload;
  readonly media?: {
    readonly payload?: string;
    readonly track?: string;
    readonly chunk?: string;
    readonly timestamp?: string;
  };
  readonly mark?: {
    readonly name?: string;
  };
}

interface TelnyxConnectionState {
  streamId: string;
  contextId: string;
  inboundCodec: TelnyxCodec;
  inboundSampleRateHz: number;
  readonly outboundCodec: TelnyxCodec;
  readonly outboundSampleRateHz: number;
  started: boolean;
  stopped: boolean;
  lastInboundSequenceNumber: number | null;
  nextInboundMediaChunk: number;
  readonly inboundMediaReorderBuffer: Map<number, PendingTelnyxMediaFrame>;
  lastInboundMediaTimestampMs: number | null;
  outboundSequence: number;
  pendingMarks: Set<string>;
  pendingEndMarkName: string;
  onPlaybackMarkReceived?: () => void;
}

interface PendingTelnyxMessage {
  readonly data: RawData;
  readonly isBinary: boolean;
  readonly byteLength: number;
}

interface PendingTelnyxMediaFrame {
  readonly chunk: number;
  readonly timestamp?: string;
  readonly pcm: Int16Array;
}

type TelnyxPlayoutTerminationReason = "stop" | "disconnect" | "overflow" | "send_buffer";

type TelnyxCodec = "PCMU" | "L16";

const DEFAULT_ENGINE_SAMPLE_RATE_HZ = 16000;
const DEFAULT_OUTBOUND_FRAME_DURATION_MS = 20;
const DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS = 30_000;
const DEFAULT_MAX_INBOUND_REORDER_FRAMES = 4;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SESSION_DURATION_MS = 30 * 60_000;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 256 * 1024;

export async function createTelnyxMediaStreamServer(
  options: TelnyxMediaStreamServerOptions,
): Promise<TelnyxMediaStreamServer> {
  const ownsHttpServer = !options.server;
  const httpServer = options.server ?? createServer();
  const routedWebSocket = createRoutedWebSocketServer(httpServer, options.path ?? "/telnyx");
  const wsServer = routedWebSocket.wsServer;
  const sessions = new Set<VoiceAgentSession>();
  const inputSampleRateHz = positiveInteger(options.inputSampleRateHz) ?? DEFAULT_ENGINE_SAMPLE_RATE_HZ;
  const outputSampleRateHz = positiveInteger(options.outputSampleRateHz) ?? DEFAULT_ENGINE_SAMPLE_RATE_HZ;
  const bidirectionalCodec = options.bidirectionalCodec ?? "PCMU";
  const outboundFrameDurationMs = positiveInteger(options.outboundFrameDurationMs) ?? DEFAULT_OUTBOUND_FRAME_DURATION_MS;
  const maxQueuedOutputAudioMs = positiveInteger(options.maxQueuedOutputAudioMs) ?? DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS;
  const maxInboundReorderFrames = positiveInteger(options.maxInboundReorderFrames) ?? DEFAULT_MAX_INBOUND_REORDER_FRAMES;
  const heartbeatIntervalMs = nonNegativeInteger(options.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const startupTimeoutMs = nonNegativeInteger(options.startupTimeoutMs) ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const maxSessionDurationMs = nonNegativeInteger(options.maxSessionDurationMs) ?? DEFAULT_MAX_SESSION_DURATION_MS;
  const maxBufferedAmountBytes = positiveInteger(options.maxBufferedAmountBytes) ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES;
  const maxInboundMessageBytes = positiveInteger(options.maxInboundMessageBytes) ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES;

  wsServer.on("connection", (socket, request) => {
    void handleTelnyxConnection({
      socket,
      request,
      createSession: options.createSession,
      contextId: options.contextId ?? defaultTelnyxContextId,
      sessions,
      inputSampleRateHz,
      outputSampleRateHz,
      bidirectionalCodec,
      outboundFrameDurationMs,
      maxQueuedOutputAudioMs,
      maxInboundReorderFrames,
      heartbeatIntervalMs,
      startupTimeoutMs,
      maxSessionDurationMs,
      maxBufferedAmountBytes,
      maxInboundMessageBytes,
    });
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
      for (const session of sessions) await session.close().catch(() => undefined);
      await new Promise<void>((resolveClose) => {
        wsServer.close(() => resolveClose());
      });
      routedWebSocket.detach();
      if (ownsHttpServer || typeof options.port === "number") {
        await new Promise<void>((resolveClose) => {
          httpServer.close(() => resolveClose());
        });
      }
    },
  };
}

async function handleTelnyxConnection(args: {
  readonly socket: WebSocket;
  readonly request: IncomingMessage;
  readonly createSession: (request: IncomingMessage) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly contextId: (start: TelnyxStartPayload) => string;
  readonly sessions: Set<VoiceAgentSession>;
  readonly inputSampleRateHz: number;
  readonly outputSampleRateHz: number;
  readonly bidirectionalCodec: TelnyxCodec;
  readonly outboundFrameDurationMs: number;
  readonly maxQueuedOutputAudioMs: number;
  readonly maxInboundReorderFrames: number;
  readonly heartbeatIntervalMs: number;
  readonly startupTimeoutMs: number;
  readonly maxSessionDurationMs: number;
  readonly maxBufferedAmountBytes: number;
  readonly maxInboundMessageBytes: number;
}): Promise<void> {
  const state: TelnyxConnectionState = {
    streamId: "",
    contextId: "",
    inboundCodec: "PCMU",
    inboundSampleRateHz: 8000,
    outboundCodec: args.bidirectionalCodec,
    outboundSampleRateHz: args.bidirectionalCodec === "L16" ? 16000 : 8000,
    started: false,
    stopped: false,
    lastInboundSequenceNumber: null,
    nextInboundMediaChunk: 1,
    inboundMediaReorderBuffer: new Map(),
    lastInboundMediaTimestampMs: null,
    outboundSequence: 0,
    pendingMarks: new Set(),
    pendingEndMarkName: "",
  };
  const disposers: Array<() => void> = [];
  const pendingMessages: PendingTelnyxMessage[] = [];
  let pendingMessageBytes = 0;
  let ready = false;
  let socketClosed = false;
  let startupTimedOut = false;
  let clearPendingPlayout: (reason: TelnyxPlayoutTerminationReason) => void = () => undefined;
  let session: VoiceAgentSession | null = null;

  const processMessage = (data: RawData, isBinary: boolean): void => {
    if (!session) return;
    if (isBinary) throw new Error("Telnyx Media Streaming messages must be JSON text frames");
    handleTelnyxMessage({
      session,
      data,
      state,
      contextId: args.contextId,
      inputSampleRateHz: args.inputSampleRateHz,
      maxInboundReorderFrames: args.maxInboundReorderFrames,
      onStop: () => clearPendingPlayout("stop"),
    });
  };
  const flushPendingInboundMedia = (): void => {
    if (!session || !state.started || state.stopped) return;
    flushTelnyxMediaReorderBuffer(session, state, args.inputSampleRateHz, args.maxInboundReorderFrames, true);
  };

  const handleMessage = (data: RawData, isBinary: boolean): void => {
    try {
      const byteLength = rawDataByteLength(data);
      if (byteLength > args.maxInboundMessageBytes) {
        sendTelnyxError(
          args.socket,
          state.streamId,
          `Telnyx websocket message exceeds maxInboundMessageBytes (${String(args.maxInboundMessageBytes)})`,
          args.maxBufferedAmountBytes,
        );
        args.socket.close(1009, "websocket message too large");
        return;
      }
      if (!ready) {
        pendingMessageBytes += byteLength;
        if (pendingMessageBytes > args.maxInboundMessageBytes) {
          sendTelnyxError(
            args.socket,
            state.streamId,
            `Pending Telnyx websocket input exceeds maxInboundMessageBytes (${String(args.maxInboundMessageBytes)}) before session ready`,
            args.maxBufferedAmountBytes,
          );
          args.socket.close(1009, "websocket pending input too large");
          return;
        }
        pendingMessages.push({ data: cloneRawData(data), isBinary, byteLength });
        return;
      }
      processMessage(data, isBinary);
    } catch (err) {
      sendTelnyxError(args.socket, state.streamId, err instanceof Error ? err.message : String(err), args.maxBufferedAmountBytes);
    }
  };

  args.socket.on("message", handleMessage);

  args.socket.on("close", () => {
    socketClosed = true;
    flushPendingInboundMedia();
    clearPendingPlayout("disconnect");
    for (const dispose of disposers.splice(0)) dispose();
    if (session) {
      args.sessions.delete(session);
      void session.close().catch(() => undefined);
    }
  });

  try {
    const startup = (async () => {
      const createdSession = await args.createSession(args.request);
      if (socketClosed || startupTimedOut) {
        await createdSession.close().catch(() => undefined);
        throw new Error("Telnyx websocket session startup aborted");
      }
      session = createdSession;
      args.sessions.add(createdSession);
      await createdSession.start();
      if (socketClosed || startupTimedOut) {
        args.sessions.delete(createdSession);
        await createdSession.close().catch(() => undefined);
        throw new Error("Telnyx websocket session startup aborted");
      }
      return createdSession;
    })();
    startup.catch(() => undefined);
    session = await withWebSocketStartupTimeout(startup, args.startupTimeoutMs);
    if (socketClosed) {
      args.sessions.delete(session);
      await session.close().catch(() => undefined);
      return;
    }
    startWebSocketHeartbeat(args.socket, args.heartbeatIntervalMs, disposers);
    startWebSocketMaxSessionDuration(args.socket, args.maxSessionDurationMs, disposers);
    clearPendingPlayout = wireTelnyxSessionEvents({
      session,
      socket: args.socket,
      state,
      disposers,
      outputSampleRateHz: args.outputSampleRateHz,
      outboundFrameDurationMs: args.outboundFrameDurationMs,
      maxQueuedOutputAudioMs: args.maxQueuedOutputAudioMs,
      maxBufferedAmountBytes: args.maxBufferedAmountBytes,
    });
    ready = true;
    for (const pending of pendingMessages.splice(0)) {
      pendingMessageBytes -= pending.byteLength;
      try {
        processMessage(pending.data, pending.isBinary);
      } catch (err) {
        sendTelnyxError(args.socket, state.streamId, err instanceof Error ? err.message : String(err), args.maxBufferedAmountBytes);
      }
    }
    pendingMessageBytes = 0;
  } catch (err) {
    if (err instanceof WebSocketStartupTimeoutError) {
      startupTimedOut = true;
      if (session) {
        args.sessions.delete(session);
        void session.close().catch(() => undefined);
      }
    }
    sendTelnyxError(args.socket, state.streamId, err instanceof Error ? err.message : String(err), args.maxBufferedAmountBytes);
    args.socket.close(1011, "session initialization failed");
    return;
  }
}

function wireTelnyxSessionEvents(args: {
  readonly session: VoiceAgentSession;
  readonly socket: WebSocket;
  readonly state: TelnyxConnectionState;
  readonly disposers: Array<() => void>;
  readonly outputSampleRateHz: number;
  readonly outboundFrameDurationMs: number;
  readonly maxQueuedOutputAudioMs: number;
  readonly maxBufferedAmountBytes: number;
}): (reason: TelnyxPlayoutTerminationReason) => void {
  const { session, socket, state, disposers, outputSampleRateHz, outboundFrameDurationMs, maxQueuedOutputAudioMs, maxBufferedAmountBytes } = args;
  const recordDiscardedPlayout = (discardedMs: number, reason: TelnyxPlayoutTerminationReason): void => {
    if (discardedMs <= 0) return;
    session.bus.push(Route.Critical, {
      kind: "record.assistant_audio",
      contextId: state.contextId,
      timestampMs: Date.now(),
      audio: new Uint8Array(0),
      truncate: true,
    });
    session.bus.push(Route.Critical, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: `telnyx.${reason}_playout_cleared_ms`,
      value: String(discardedMs),
    });
  };
  const playoutProgress = new PlayoutProgressEmitter(session.bus);
  const playout = new PacedPlayoutQueue(outboundFrameDurationMs, maxQueuedOutputAudioMs, (discardedMs) => {
    state.stopped = true;
    recordDiscardedPlayout(discardedMs, "overflow");
    closeWebSocketWithFallback(socket, 1013, "outbound audio queue exceeded");
  }, (discardedMs) => {
    state.stopped = true;
    recordDiscardedPlayout(discardedMs, "send_buffer");
  }, (lateMs) => {
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: "telnyx.pacer_deadline_miss",
      value: String(lateMs),
    });
  }, playoutProgress.onFramePlayed);
  const sendPendingEndMark = (): void => {
    if (state.stopped || !state.streamId || !state.pendingEndMarkName || state.pendingMarks.size > 0) return;
    const markName = state.pendingEndMarkName;
    const sent = sendTelnyxJson(socket, {
      event: "mark",
      mark: {
        name: markName,
      },
    }, maxBufferedAmountBytes);
    if (sent) state.pendingEndMarkName = "";
  };
  state.onPlaybackMarkReceived = sendPendingEndMark;
  const interruptedContextIds = new Set<string>();

  disposers.push(
    () => playout.close(),
    session.bus.on("interrupt.tts", (pkt) => {
      const interrupt = pkt as InterruptTtsPacket;
      interruptedContextIds.add(interrupt.contextId);
      playoutProgress.discard(interrupt.contextId);
      playout.clear();
      state.pendingMarks.clear();
      state.pendingEndMarkName = "";
      const sent = !state.stopped && state.streamId && sendTelnyxJson(socket, { event: "clear" }, maxBufferedAmountBytes);
      if (sent) {
        session.bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId: interrupt.contextId,
          timestampMs: Date.now(),
          name: "telnyx.clear_sent",
          value: "1",
        });
      }
    }),
    session.bus.on("tts.audio", (pkt) => {
      const audioPacket = pkt as TextToSpeechAudioPacket;
      if (interruptedContextIds.has(audioPacket.contextId)) return;
      if (state.stopped || !state.streamId) return;
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
      const payload = encodeOutboundPayload(audioPacket.audio, requireTtsAudioSampleRate(audioPacket.sampleRateHz), state, outboundFrameDurationMs);
      const frames: PacedPlayoutFrame[] = payload.map((frame) => ({
        contextId: audioPacket.contextId,
        send: () => {
          if (state.stopped) return false;
          return sendTelnyxJson(socket, {
            event: "media",
            media: {
              payload: Buffer.from(frame).toString("base64"),
            },
          }, maxBufferedAmountBytes);
        },
      }));
      state.outboundSequence += 1;
      const markName = `${audioPacket.contextId}:${String(state.outboundSequence)}`;
      const finalFrame = frames.at(-1);
      if (finalFrame) {
        frames[frames.length - 1] = {
          send: finalFrame.send,
          afterSend: () => {
            if (state.stopped) return;
            const sent = sendTelnyxJson(socket, {
              event: "mark",
              mark: {
                name: markName,
              },
            }, maxBufferedAmountBytes);
            if (sent) {
              state.pendingMarks.add(markName);
              session.bus.push(Route.Background, {
                kind: "metric.conversation",
                contextId: audioPacket.contextId,
                timestampMs: Date.now(),
                name: "telnyx.mark_sent",
                value: markName,
              });
            }
          },
        };
        playout.enqueue(frames);
      }
    }),
    session.bus.on("tts.end", (pkt) => {
      const end = pkt as TextToSpeechEndPacket;
      if (interruptedContextIds.has(end.contextId)) return;
      if (state.stopped || !state.streamId) return;
      playout.enqueueControl(() => {
        if (state.stopped || !state.streamId) return;
        playoutProgress.complete(end.contextId);
        state.pendingEndMarkName = `${end.contextId}:end`;
        sendPendingEndMark();
      });
    }),
  );

  return (reason) => {
    recordDiscardedPlayout(playout.clear(), reason);
  };
}

function handleTelnyxMessage(args: {
  readonly session: VoiceAgentSession;
  readonly data: RawData;
  readonly state: TelnyxConnectionState;
  readonly contextId: (start: TelnyxStartPayload) => string;
  readonly inputSampleRateHz: number;
  readonly maxInboundReorderFrames: number;
  readonly onStop: () => void;
}): void {
  const { session, data, state, contextId, inputSampleRateHz, maxInboundReorderFrames, onStop } = args;
  const message = parseTelnyxMessage(parseJsonRecord(rawDataToText(data), "Telnyx Media Streaming message"));
  const event = message.event;
  rememberTelnyxSequenceNumber(session, state, message.sequence_number);

  if (event === "connected") return;
  if (event === "start") {
    if (state.stopped) throw new Error("Telnyx start event received after stream stop");
    const start = message.start ?? {};
    const format = validateTelnyxStart(start);
    state.streamId = message.stream_id ?? start.stream_id ?? "";
    if (!state.streamId) throw new Error("Telnyx start event is missing stream_id");
    state.contextId = contextId(start);
    state.inboundCodec = format.codec;
    state.inboundSampleRateHz = format.sampleRateHz;
    state.started = true;
    state.nextInboundMediaChunk = 1;
    state.inboundMediaReorderBuffer.clear();
    return;
  }
  if (event === "media") {
    if (state.stopped) return;
    if (!state.started || !state.contextId) throw new Error("Telnyx media event received before a valid start event");
    const payload = message.media?.payload;
    if (!payload) throw new Error("Telnyx media event is missing media.payload");
    const encoded = decodeStrictBase64(payload, "media.payload");
    const pcm = decodeInboundPayload(encoded, state.inboundCodec);
    const chunk = optionalPositiveIntegerString(message.media?.chunk, "Telnyx media.chunk");
    if (chunk === undefined) {
      emitTelnyxMediaFrame(session, state, { chunk: 0, timestamp: message.media?.timestamp, pcm }, inputSampleRateHz);
    } else {
      rememberTelnyxMediaChunk(session, state, { chunk, timestamp: message.media?.timestamp, pcm }, inputSampleRateHz, maxInboundReorderFrames);
    }
    return;
  }
  if (event === "stop") {
    flushTelnyxMediaReorderBuffer(session, state, inputSampleRateHz, maxInboundReorderFrames, true);
    state.stopped = true;
    state.started = false;
    state.pendingMarks.clear();
    onStop();
    session.close().catch(() => undefined);
    return;
  }
  if (event === "mark") {
    if (state.stopped) return;
    const markName = message.mark?.name ?? "";
    if (markName) state.pendingMarks.delete(markName);
    state.onPlaybackMarkReceived?.();
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: "telnyx.mark_received",
      value: markName,
    });
    return;
  }
  if (event === "dtmf") return;

  throw new Error(`Unsupported Telnyx Media Streaming event: ${String(event)}`);
}

function parseTelnyxMessage(value: Record<string, unknown>): TelnyxMediaMessage {
  const start = optionalRecord(value.start, "Telnyx start");
  const media = optionalRecord(value.media, "Telnyx media");
  const mark = optionalRecord(value.mark, "Telnyx mark");
  const mediaFormat = optionalRecord(start?.media_format, "Telnyx start.media_format");
  return {
    event: requiredString(value.event, "Telnyx event"),
    stream_id: optionalString(value.stream_id, "Telnyx stream_id"),
    sequence_number: optionalString(value.sequence_number, "Telnyx sequence_number"),
    start: start
      ? {
          stream_id: optionalString(start.stream_id, "Telnyx start.stream_id"),
          call_control_id: optionalString(start.call_control_id, "Telnyx start.call_control_id"),
          call_session_id: optionalString(start.call_session_id, "Telnyx start.call_session_id"),
          media_format: mediaFormat
            ? {
                encoding: optionalString(mediaFormat.encoding, "Telnyx start.media_format.encoding"),
                sample_rate: optionalStringOrNumber(mediaFormat.sample_rate, "Telnyx start.media_format.sample_rate"),
                channels: optionalStringOrNumber(mediaFormat.channels, "Telnyx start.media_format.channels"),
              }
            : undefined,
        }
      : undefined,
    media: media
      ? {
          payload: optionalString(media.payload, "Telnyx media.payload"),
          track: optionalString(media.track, "Telnyx media.track"),
          chunk: optionalString(media.chunk, "Telnyx media.chunk"),
          timestamp: optionalString(media.timestamp, "Telnyx media.timestamp"),
        }
      : undefined,
    mark: mark
      ? {
          name: optionalString(mark.name, "Telnyx mark.name"),
        }
      : undefined,
  };
}

function rememberTelnyxSequenceNumber(
  session: VoiceAgentSession,
  state: TelnyxConnectionState,
  sequenceValue: string | undefined,
): void {
  const sequence = optionalPositiveIntegerString(sequenceValue, "Telnyx sequence_number");
  if (sequence === undefined) return;
  const previous = state.lastInboundSequenceNumber;
  if (previous !== null && sequence <= previous) {
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: "telnyx.sequence_regression",
      value: JSON.stringify({ previous, actual: sequence }),
    });
    return;
  }
  if (previous !== null && sequence > previous + 1) {
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: "telnyx.sequence_gap",
      value: JSON.stringify({ expected: previous + 1, actual: sequence, missed: sequence - previous - 1 }),
    });
  }
  state.lastInboundSequenceNumber = sequence;
}

function rememberTelnyxMediaChunk(
  session: VoiceAgentSession,
  state: TelnyxConnectionState,
  frame: PendingTelnyxMediaFrame,
  inputSampleRateHz: number,
  maxInboundReorderFrames: number,
): void {
  if (frame.chunk < state.nextInboundMediaChunk) {
    throw new Error(`Telnyx media.chunk is stale or duplicated: expected at least ${String(state.nextInboundMediaChunk)}, received ${String(frame.chunk)}`);
  }
  if (state.inboundMediaReorderBuffer.has(frame.chunk)) {
    throw new Error(`Telnyx media.chunk is stale or duplicated: expected at least ${String(state.nextInboundMediaChunk)}, received ${String(frame.chunk)}`);
  }
  state.inboundMediaReorderBuffer.set(frame.chunk, frame);
  flushTelnyxMediaReorderBuffer(session, state, inputSampleRateHz, maxInboundReorderFrames, false);
}

function flushTelnyxMediaReorderBuffer(
  session: VoiceAgentSession,
  state: TelnyxConnectionState,
  inputSampleRateHz: number,
  maxInboundReorderFrames: number,
  force: boolean,
): void {
  while (state.inboundMediaReorderBuffer.size > 0) {
    const next = state.inboundMediaReorderBuffer.get(state.nextInboundMediaChunk);
    if (next) {
      state.inboundMediaReorderBuffer.delete(state.nextInboundMediaChunk);
      state.nextInboundMediaChunk += 1;
      emitTelnyxMediaFrame(session, state, next, inputSampleRateHz);
      continue;
    }

    if (!force && state.inboundMediaReorderBuffer.size <= maxInboundReorderFrames) break;

    const lowestBufferedChunk = Math.min(...state.inboundMediaReorderBuffer.keys());
    if (lowestBufferedChunk > state.nextInboundMediaChunk) {
      session.bus.push(force ? Route.Critical : Route.Background, {
        kind: "metric.conversation",
        contextId: state.contextId,
        timestampMs: Date.now(),
        name: "telnyx.media_chunk_gap",
        value: JSON.stringify({
          expected: state.nextInboundMediaChunk,
          actual: lowestBufferedChunk,
          missed: lowestBufferedChunk - state.nextInboundMediaChunk,
        }),
      });
      state.nextInboundMediaChunk = lowestBufferedChunk;
      continue;
    }
    break;
  }
}

function emitTelnyxMediaFrame(
  session: VoiceAgentSession,
  state: TelnyxConnectionState,
  frame: PendingTelnyxMediaFrame,
  inputSampleRateHz: number,
): void {
  rememberTelnyxMediaTimestamp(session, state, frame.timestamp, frame.pcm.length, state.inboundSampleRateHz);
  const resampled = resamplePcm16(frame.pcm, state.inboundSampleRateHz, inputSampleRateHz);
  session.bus.push(Route.Main, {
    kind: "user.audio_received",
    contextId: state.contextId,
    timestampMs: Date.now(),
    audio: pcm16SamplesToBytes(resampled),
  });
}

function rememberTelnyxMediaTimestamp(
  session: VoiceAgentSession,
  state: TelnyxConnectionState,
  timestampValue: string | undefined,
  sampleCount: number,
  sampleRateHz: number,
): void {
  const timestampMs = optionalNonNegativeIntegerString(timestampValue, "Telnyx media.timestamp");
  if (timestampMs === undefined) return;
  const previous = state.lastInboundMediaTimestampMs;
  if (previous !== null && timestampMs < previous) {
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: "telnyx.media_timestamp_regression",
      value: JSON.stringify({ previous, actual: timestampMs }),
    });
  } else if (previous !== null) {
    const expected = previous + Math.round((sampleCount / sampleRateHz) * 1000);
    if (timestampMs > expected) {
      session.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: state.contextId,
        timestampMs: Date.now(),
        name: "telnyx.media_timestamp_gap",
        value: JSON.stringify({ expected, actual: timestampMs, missedMs: timestampMs - expected }),
      });
    }
  }
  state.lastInboundMediaTimestampMs = timestampMs;
}

function validateTelnyxStart(start: TelnyxStartPayload): { readonly codec: TelnyxCodec; readonly sampleRateHz: number } {
  const format = start.media_format;
  if (!format) throw new Error("Telnyx start event is missing media_format");

  const encoding = format.encoding?.trim().toUpperCase();
  if (encoding !== "PCMU" && encoding !== "L16") {
    throw new Error(`Unsupported Telnyx media encoding: ${format.encoding ?? "unknown"}`);
  }

  const sampleRateHz = numberFromString(format.sample_rate);
  if (encoding === "PCMU" && sampleRateHz !== 8000) {
    throw new Error(`Unsupported Telnyx PCMU sample rate: ${String(format.sample_rate)}`);
  }
  if (encoding === "L16" && sampleRateHz !== 16000) {
    throw new Error(`Unsupported Telnyx L16 sample rate: ${String(format.sample_rate)}`);
  }
  if (sampleRateHz === null) {
    throw new Error(`Unsupported Telnyx sample rate: ${String(format.sample_rate)}`);
  }

  const channels = numberFromString(format.channels);
  if (channels !== 1) throw new Error(`Unsupported Telnyx channel count: ${String(format.channels)}`);
  return { codec: encoding, sampleRateHz };
}

function decodeInboundPayload(input: Uint8Array, codec: TelnyxCodec): Int16Array {
  if (codec === "PCMU") return decodeMuLawToPcm16(input);
  return bigEndianPcm16BytesToSamples(input);
}

function encodeOutboundPayload(
  audio: Uint8Array,
  sourceSampleRateHz: number,
  state: TelnyxConnectionState,
  frameDurationMs: number,
): Uint8Array[] {
  const samples = pcm16BytesToSamples(audio);
  const resampled = resamplePcm16(samples, sourceSampleRateHz, state.outboundSampleRateHz);
  const encoded = state.outboundCodec === "PCMU"
    ? encodePcm16ToMuLaw(resampled)
    : pcm16SamplesToBigEndianBytes(resampled);
  const frameBytes = Math.max(1, Math.round((state.outboundSampleRateHz * frameDurationMs) / 1000) * (state.outboundCodec === "L16" ? 2 : 1));
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < encoded.byteLength; offset += frameBytes) {
    frames.push(encoded.subarray(offset, Math.min(encoded.byteLength, offset + frameBytes)));
  }
  return frames;
}

function defaultTelnyxContextId(start: TelnyxStartPayload): string {
  const callControlId = start.call_control_id?.trim();
  if (callControlId) return `telnyx-${callControlId}`;
  const callSessionId = start.call_session_id?.trim();
  if (callSessionId) return `telnyx-${callSessionId}`;
  const streamId = start.stream_id?.trim();
  if (streamId) return `telnyx-${streamId}`;
  return `telnyx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function numberFromString(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function requireTtsAudioSampleRate(value: unknown): number {
  const sampleRateHz = positiveInteger(value);
  if (sampleRateHz === null) throw new Error("tts.audio sampleRateHz must be a positive integer");
  return sampleRateHz;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function optionalPositiveIntegerString(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a positive integer string`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer string`);
  return parsed;
}

function optionalNonNegativeIntegerString(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a non-negative integer string`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a non-negative integer string`);
  return parsed;
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  throw new Error("Unsupported text message payload");
}

function rawDataByteLength(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return 0;
}

function cloneRawData(data: RawData): RawData {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (Array.isArray(data)) return data.map((chunk) => Buffer.from(chunk));
  throw new Error("Unsupported websocket message payload");
}

function decodeStrictBase64(value: string, fieldName: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${fieldName} must be a non-empty base64 string`);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`${fieldName} must be valid base64`);
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function sendTelnyxError(socket: WebSocket, streamId: string, message: string, maxBufferedAmountBytes: number): void {
  sendTelnyxJson(socket, {
    event: "error",
    stream_id: streamId || undefined,
    payload: {
      code: 100003,
      title: "syrinx_transport_error",
      detail: message,
    },
  }, maxBufferedAmountBytes);
}

function sendTelnyxJson(socket: WebSocket, value: unknown, maxBufferedAmountBytes: number): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const data = JSON.stringify(value);
  if (socket.bufferedAmount + Buffer.byteLength(data, "utf8") > maxBufferedAmountBytes) {
    closeWebSocketWithFallback(socket, 1013, "websocket send buffer exceeded");
    return false;
  }
  socket.send(data);
  return true;
}
