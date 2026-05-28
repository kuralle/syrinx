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
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
  pcm16BytesToSamples,
  pcm16SamplesToBytes,
  resamplePcm16,
} from "./twilio.js";
import { PacedPlayoutQueue, type PacedPlayoutFrame } from "./paced-playout.js";
import { closeWebSocketWithFallback } from "./websocket-close.js";
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
  readonly heartbeatIntervalMs?: number;
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

type TelnyxPlayoutTerminationReason = "stop" | "disconnect" | "overflow" | "send_buffer";

type TelnyxCodec = "PCMU" | "L16";

const DEFAULT_ENGINE_SAMPLE_RATE_HZ = 16000;
const DEFAULT_OUTBOUND_FRAME_DURATION_MS = 20;
const DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
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
  const heartbeatIntervalMs = nonNegativeInteger(options.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
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
      heartbeatIntervalMs,
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
  readonly heartbeatIntervalMs: number;
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
    outboundSequence: 0,
    pendingMarks: new Set(),
    pendingEndMarkName: "",
  };
  const disposers: Array<() => void> = [];
  const pendingMessages: PendingTelnyxMessage[] = [];
  let pendingMessageBytes = 0;
  let ready = false;
  let socketClosed = false;
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
      onStop: () => clearPendingPlayout("stop"),
    });
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
    clearPendingPlayout("disconnect");
    for (const dispose of disposers.splice(0)) dispose();
    if (session) {
      args.sessions.delete(session);
      void session.close().catch(() => undefined);
    }
  });

  try {
    session = await args.createSession(args.request);
    args.sessions.add(session);
    if (socketClosed) {
      args.sessions.delete(session);
      await session.close().catch(() => undefined);
      return;
    }
    startWebSocketHeartbeat(args.socket, args.heartbeatIntervalMs, disposers);
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
    await session.start();
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
  const playout = new PacedPlayoutQueue(outboundFrameDurationMs, maxQueuedOutputAudioMs, (discardedMs) => {
    state.stopped = true;
    recordDiscardedPlayout(discardedMs, "overflow");
    closeWebSocketWithFallback(socket, 1013, "outbound audio queue exceeded");
  }, (discardedMs) => {
    state.stopped = true;
    recordDiscardedPlayout(discardedMs, "send_buffer");
  });
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
      if (state.stopped || !state.streamId || socket.readyState !== WebSocket.OPEN) return;
      const payload = encodeOutboundPayload(audioPacket.audio, outputSampleRateHz, state, outboundFrameDurationMs);
      const frames: PacedPlayoutFrame[] = payload.map((frame) => ({
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
  readonly onStop: () => void;
}): void {
  const { session, data, state, contextId, inputSampleRateHz, onStop } = args;
  const message = JSON.parse(rawDataToText(data)) as TelnyxMediaMessage;
  const event = message.event;

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
    return;
  }
  if (event === "media") {
    if (state.stopped) return;
    if (!state.started || !state.contextId) throw new Error("Telnyx media event received before a valid start event");
    const payload = message.media?.payload;
    if (!payload) throw new Error("Telnyx media event is missing media.payload");
    const encoded = decodeStrictBase64(payload, "media.payload");
    const pcm = decodeInboundPayload(encoded, state.inboundCodec);
    const resampled = resamplePcm16(pcm, state.inboundSampleRateHz, inputSampleRateHz);
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: state.contextId,
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(resampled),
    });
    return;
  }
  if (event === "stop") {
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

function bigEndianPcm16BytesToSamples(audio: Uint8Array): Int16Array {
  if (audio.byteLength % 2 !== 0) throw new Error("L16 audio payload must contain an even number of bytes");
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const samples = new Int16Array(audio.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, false);
  }
  return samples;
}

function pcm16SamplesToBigEndianBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.byteLength);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i]!, false);
  }
  return bytes;
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

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
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

function startWebSocketHeartbeat(socket: WebSocket, heartbeatIntervalMs: number, disposers: Array<() => void>): void {
  if (heartbeatIntervalMs <= 0) return;
  let alive = true;
  const onPong = () => {
    alive = true;
  };
  socket.on("pong", onPong);
  const interval = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, heartbeatIntervalMs);
  disposers.push(() => {
    clearInterval(interval);
    socket.off("pong", onPong);
  });
}
