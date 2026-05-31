// SPDX-License-Identifier: MIT

import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from "@evan/opus";
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

export interface SmartPbxMediaStreamServerOptions {
  readonly server?: HttpServer;
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  readonly createSession: (request: IncomingMessage) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly contextId?: (start: SmartPbxStartPayload) => string;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
  readonly outboundFrameDurationMs?: number;
  readonly maxQueuedOutputAudioMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly startupTimeoutMs?: number;
  readonly maxSessionDurationMs?: number;
  readonly maxBufferedAmountBytes?: number;
  readonly maxInboundMessageBytes?: number;
}

export interface SmartPbxMediaStreamServer {
  readonly httpServer: HttpServer;
  readonly wsServer: WebSocketServer;
  address(): ReturnType<HttpServer["address"]>;
  close(): Promise<void>;
}

export interface SmartPbxStartPayload {
  readonly callId?: string;
  readonly otherLegCallId?: string;
  readonly callerIdNumber?: string;
  readonly calleeIdNumber?: string;
  readonly accountId?: string;
  readonly mediaFormat?: {
    readonly encoding?: string;
    readonly sampleRate?: number | string;
  };
}

interface SmartPbxMessage {
  readonly event?: string;
  readonly start?: SmartPbxStartPayload;
  readonly media?: {
    readonly payload?: string;
  };
}

type SmartPbxCodec = "g711_ulaw" | "pcm16" | "opus";

interface SmartPbxConnectionState {
  callId: string;
  accountId: string;
  contextId: string;
  codec: SmartPbxCodec;
  wireSampleRateHz: number;
  opusDecoder: OpusDecoder | null;
  opusEncoder: OpusEncoder | null;
  opusEncodeRemainder: Int16Array;
  started: boolean;
  stopped: boolean;
}

interface PendingSmartPbxMessage {
  readonly data: RawData;
  readonly isBinary: boolean;
  readonly byteLength: number;
}

type SmartPbxPlayoutTerminationReason = "stop" | "disconnect" | "overflow" | "send_buffer";

const DEFAULT_ENGINE_SAMPLE_RATE_HZ = 16000;
const DEFAULT_OUTBOUND_FRAME_DURATION_MS = 20;
const DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SESSION_DURATION_MS = 30 * 60_000;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 256 * 1024;

export async function createSmartPbxMediaStreamServer(
  options: SmartPbxMediaStreamServerOptions,
): Promise<SmartPbxMediaStreamServer> {
  const ownsHttpServer = !options.server;
  const httpServer = options.server ?? createServer();
  const routedWebSocket = createRoutedWebSocketServer(httpServer, options.path ?? "/media-stream");
  const wsServer = routedWebSocket.wsServer;
  const sessions = new Set<VoiceAgentSession>();
  const inputSampleRateHz = positiveInteger(options.inputSampleRateHz) ?? DEFAULT_ENGINE_SAMPLE_RATE_HZ;
  const outputSampleRateHz = positiveInteger(options.outputSampleRateHz) ?? DEFAULT_ENGINE_SAMPLE_RATE_HZ;
  const outboundFrameDurationMs = positiveInteger(options.outboundFrameDurationMs) ?? DEFAULT_OUTBOUND_FRAME_DURATION_MS;
  const maxQueuedOutputAudioMs = positiveInteger(options.maxQueuedOutputAudioMs) ?? DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS;
  const heartbeatIntervalMs = nonNegativeInteger(options.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const startupTimeoutMs = nonNegativeInteger(options.startupTimeoutMs) ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const maxSessionDurationMs = nonNegativeInteger(options.maxSessionDurationMs) ?? DEFAULT_MAX_SESSION_DURATION_MS;
  const maxBufferedAmountBytes = positiveInteger(options.maxBufferedAmountBytes) ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES;
  const maxInboundMessageBytes = positiveInteger(options.maxInboundMessageBytes) ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES;

  wsServer.on("connection", (socket, request) => {
    void handleSmartPbxConnection({
      socket,
      request,
      createSession: options.createSession,
      contextId: options.contextId ?? defaultSmartPbxContextId,
      sessions,
      inputSampleRateHz,
      outputSampleRateHz,
      outboundFrameDurationMs,
      maxQueuedOutputAudioMs,
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

async function handleSmartPbxConnection(args: {
  readonly socket: WebSocket;
  readonly request: IncomingMessage;
  readonly createSession: (request: IncomingMessage) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly contextId: (start: SmartPbxStartPayload) => string;
  readonly sessions: Set<VoiceAgentSession>;
  readonly inputSampleRateHz: number;
  readonly outputSampleRateHz: number;
  readonly outboundFrameDurationMs: number;
  readonly maxQueuedOutputAudioMs: number;
  readonly heartbeatIntervalMs: number;
  readonly startupTimeoutMs: number;
  readonly maxSessionDurationMs: number;
  readonly maxBufferedAmountBytes: number;
  readonly maxInboundMessageBytes: number;
}): Promise<void> {
  const state: SmartPbxConnectionState = {
    callId: "",
    accountId: "",
    contextId: "",
    codec: "g711_ulaw",
    wireSampleRateHz: 8000,
    opusDecoder: null,
    opusEncoder: null,
    opusEncodeRemainder: new Int16Array(0),
    started: false,
    stopped: false,
  };
  const disposers: Array<() => void> = [];
  const pendingMessages: PendingSmartPbxMessage[] = [];
  let pendingMessageBytes = 0;
  let ready = false;
  let socketClosed = false;
  let startupTimedOut = false;
  let clearPendingPlayout: (reason: SmartPbxPlayoutTerminationReason) => void = () => undefined;
  let session: VoiceAgentSession | null = null;

  const processMessage = (data: RawData, isBinary: boolean): void => {
    if (!session) return;
    if (isBinary) throw new Error("SmartPBX AI Provider messages must be JSON text frames");
    handleSmartPbxMessage({
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
        sendSmartPbxError(
          args.socket,
          state,
          `SmartPBX websocket message exceeds maxInboundMessageBytes (${String(args.maxInboundMessageBytes)})`,
          args.maxBufferedAmountBytes,
        );
        args.socket.close(1009, "websocket message too large");
        return;
      }
      if (!ready) {
        pendingMessageBytes += byteLength;
        if (pendingMessageBytes > args.maxInboundMessageBytes) {
          sendSmartPbxError(
            args.socket,
            state,
            `Pending SmartPBX websocket input exceeds maxInboundMessageBytes (${String(args.maxInboundMessageBytes)}) before session ready`,
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
      sendSmartPbxError(args.socket, state, err instanceof Error ? err.message : String(err), args.maxBufferedAmountBytes);
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
    const startup = (async () => {
      const createdSession = await args.createSession(args.request);
      if (socketClosed || startupTimedOut) {
        await createdSession.close().catch(() => undefined);
        throw new Error("SmartPBX websocket session startup aborted");
      }
      session = createdSession;
      args.sessions.add(createdSession);
      await createdSession.start();
      if (socketClosed || startupTimedOut) {
        args.sessions.delete(createdSession);
        await createdSession.close().catch(() => undefined);
        throw new Error("SmartPBX websocket session startup aborted");
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
    clearPendingPlayout = wireSmartPbxSessionEvents({
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
        sendSmartPbxError(args.socket, state, err instanceof Error ? err.message : String(err), args.maxBufferedAmountBytes);
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
    sendSmartPbxError(args.socket, state, err instanceof Error ? err.message : String(err), args.maxBufferedAmountBytes);
    args.socket.close(1011, "session initialization failed");
    return;
  }
}

function wireSmartPbxSessionEvents(args: {
  readonly session: VoiceAgentSession;
  readonly socket: WebSocket;
  readonly state: SmartPbxConnectionState;
  readonly disposers: Array<() => void>;
  readonly outputSampleRateHz: number;
  readonly outboundFrameDurationMs: number;
  readonly maxQueuedOutputAudioMs: number;
  readonly maxBufferedAmountBytes: number;
}): (reason: SmartPbxPlayoutTerminationReason) => void {
  const { session, socket, state, disposers, outputSampleRateHz, outboundFrameDurationMs, maxQueuedOutputAudioMs, maxBufferedAmountBytes } = args;
  const recordDiscardedPlayout = (discardedMs: number, reason: SmartPbxPlayoutTerminationReason): void => {
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
      name: `smartpbx.${reason}_playout_cleared_ms`,
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
    state.opusEncodeRemainder = new Int16Array(0);
    recordDiscardedPlayout(discardedMs, "send_buffer");
  }, (lateMs) => {
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: "smartpbx.pacer_deadline_miss",
      value: String(lateMs),
    });
  }, playoutProgress.onFramePlayed);
  const interruptedContextIds = new Set<string>();

  disposers.push(
    () => playout.close(),
    session.bus.on("interrupt.tts", (pkt) => {
      const interrupt = pkt as InterruptTtsPacket;
      interruptedContextIds.add(interrupt.contextId);
      playoutProgress.discard(interrupt.contextId);
      playout.clear();
      state.opusEncodeRemainder = new Int16Array(0);
      session.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: interrupt.contextId,
        timestampMs: Date.now(),
        name: "smartpbx.interrupt_no_playback_clear",
        value: "1",
      });
    }),
    session.bus.on("tts.audio", (pkt) => {
      const audioPacket = pkt as TextToSpeechAudioPacket;
      if (interruptedContextIds.has(audioPacket.contextId)) return;
      if (state.stopped || !state.started) return;
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
      const frames: PacedPlayoutFrame[] = encodeOutboundFrames(audioPacket.audio, requireTtsAudioSampleRate(audioPacket.sampleRateHz), state, outboundFrameDurationMs)
        .map((frame) => ({
          contextId: audioPacket.contextId,
          send: () => {
            if (state.stopped) return false;
            return sendSmartPbxJson(socket, {
              event: "media",
              callId: state.callId,
              accountId: state.accountId,
              media: {
                payload: Buffer.from(frame).toString("base64"),
              },
            }, maxBufferedAmountBytes);
          },
        }));
      playout.enqueue(frames);
    }),
    session.bus.on("tts.end", (pkt) => {
      const end = pkt as TextToSpeechEndPacket;
      if (interruptedContextIds.has(end.contextId)) return;
      if (state.stopped || !state.started) return;
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
      const frames: PacedPlayoutFrame[] = encodePendingOpusFrame(state, outboundFrameDurationMs)
        .map((frame) => ({
          contextId: end.contextId,
          send: () => {
            if (state.stopped) return false;
            return sendSmartPbxJson(socket, {
              event: "media",
              callId: state.callId,
              accountId: state.accountId,
              media: {
                payload: Buffer.from(frame).toString("base64"),
              },
            }, maxBufferedAmountBytes);
          },
        }));
      playout.enqueue(frames);
      playout.enqueueControl(() => {
        if (state.stopped) return;
        playoutProgress.complete(end.contextId);
        session.bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId: end.contextId,
          timestampMs: Date.now(),
          name: "smartpbx.playout_drained",
          value: "1",
        });
      });
    }),
  );

  return (reason) => {
    state.opusEncodeRemainder = new Int16Array(0);
    recordDiscardedPlayout(playout.clear(), reason);
  };
}

function handleSmartPbxMessage(args: {
  readonly session: VoiceAgentSession;
  readonly data: RawData;
  readonly state: SmartPbxConnectionState;
  readonly contextId: (start: SmartPbxStartPayload) => string;
  readonly inputSampleRateHz: number;
  readonly onStop: () => void;
}): void {
  const { session, data, state, contextId, inputSampleRateHz, onStop } = args;
  const message = parseSmartPbxMessage(parseJsonRecord(rawDataToText(data), "SmartPBX AI Provider message"));

  if (message.event === "connected") return;
  if (message.event === "start") {
    if (state.stopped) throw new Error("SmartPBX start event received after stream stop");
    const start = message.start ?? {};
    const format = validateSmartPbxStart(start);
    state.callId = start.callId ?? "";
    state.accountId = start.accountId ?? "";
    if (!state.callId) throw new Error("SmartPBX start event is missing callId");
    if (!state.accountId) throw new Error("SmartPBX start event is missing accountId");
    state.contextId = contextId(start);
    state.codec = format.codec;
    state.wireSampleRateHz = format.sampleRateHz;
    state.opusDecoder = format.codec === "opus" ? new OpusDecoder({ channels: 1, sample_rate: 48000 }) : null;
    state.opusEncoder = format.codec === "opus" ? new OpusEncoder({ channels: 1, sample_rate: 48000, application: "voip" }) : null;
    state.opusEncodeRemainder = new Int16Array(0);
    state.started = true;
    return;
  }
  if (message.event === "media") {
    if (state.stopped) return;
    if (!state.started || !state.contextId) throw new Error("SmartPBX media event received before a valid start event");
    const payload = message.media?.payload;
    if (!payload) throw new Error("SmartPBX media event is missing media.payload");
    const wire = decodeStrictBase64(payload, "media.payload");
    const decoded = decodeSmartPbxWireAudio(wire, state);
    const resampled = resamplePcm16(decoded, state.wireSampleRateHz, inputSampleRateHz);
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: state.contextId,
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(resampled),
    });
    return;
  }
  if (message.event === "hangup" || message.event === "stop") {
    state.stopped = true;
    state.started = false;
    state.opusEncodeRemainder = new Int16Array(0);
    onStop();
    session.close().catch(() => undefined);
    return;
  }
  if (message.event === "dtmf") return;
  throw new Error(`Unsupported SmartPBX AI Provider event: ${String(message.event)}`);
}

function parseSmartPbxMessage(value: Record<string, unknown>): SmartPbxMessage {
  const start = optionalRecord(value.start, "SmartPBX start");
  const media = optionalRecord(value.media, "SmartPBX media");
  const mediaFormat = optionalRecord(start?.mediaFormat, "SmartPBX start.mediaFormat");
  return {
    event: requiredString(value.event, "SmartPBX event"),
    start: start
      ? {
          callId: optionalString(start.callId, "SmartPBX start.callId"),
          otherLegCallId: optionalString(start.otherLegCallId, "SmartPBX start.otherLegCallId"),
          callerIdNumber: optionalString(start.callerIdNumber, "SmartPBX start.callerIdNumber"),
          calleeIdNumber: optionalString(start.calleeIdNumber, "SmartPBX start.calleeIdNumber"),
          accountId: optionalString(start.accountId, "SmartPBX start.accountId"),
          mediaFormat: mediaFormat
            ? {
                encoding: optionalString(mediaFormat.encoding, "SmartPBX start.mediaFormat.encoding"),
                sampleRate: optionalStringOrNumber(mediaFormat.sampleRate, "SmartPBX start.mediaFormat.sampleRate"),
              }
            : undefined,
        }
      : undefined,
    media: media
      ? {
          payload: optionalString(media.payload, "SmartPBX media.payload"),
        }
      : undefined,
  };
}

function validateSmartPbxStart(start: SmartPbxStartPayload): { readonly codec: SmartPbxCodec; readonly sampleRateHz: number } {
  const format = start.mediaFormat;
  if (!format) throw new Error("SmartPBX start event is missing mediaFormat");
  const encoding = format.encoding?.trim().toLowerCase();
  const sampleRateHz = numberFromString(format.sampleRate);
  if (encoding !== "g711_ulaw" && encoding !== "pcm16" && encoding !== "opus") {
    throw new Error(`Unsupported SmartPBX media encoding: ${format.encoding ?? "unknown"}`);
  }
  if (encoding === "g711_ulaw" && sampleRateHz !== 8000) {
    throw new Error(`Unsupported SmartPBX g711_ulaw sample rate: ${String(format.sampleRate)}`);
  }
  if (encoding === "pcm16" && sampleRateHz !== 24000) {
    throw new Error(`Unsupported SmartPBX pcm16 sample rate: ${String(format.sampleRate)}`);
  }
  if (encoding === "opus" && sampleRateHz !== 48000) {
    throw new Error(`Unsupported SmartPBX opus sample rate: ${String(format.sampleRate)}`);
  }
  return { codec: encoding, sampleRateHz: sampleRateHz! };
}

function decodeSmartPbxWireAudio(wire: Uint8Array, state: SmartPbxConnectionState): Int16Array {
  if (state.codec === "g711_ulaw") return decodeMuLawToPcm16(wire);
  if (state.codec === "pcm16") return pcm16BytesToSamples(wire);
  if (!state.opusDecoder) throw new Error("SmartPBX opus decoder is not initialized");
  return pcm16BytesToSamples(state.opusDecoder.decode(wire));
}

function encodeOutboundFrames(
  audio: Uint8Array,
  sourceSampleRateHz: number,
  state: SmartPbxConnectionState,
  frameDurationMs: number,
): Uint8Array[] {
  const samples = pcm16BytesToSamples(audio);
  const resampled = resamplePcm16(samples, sourceSampleRateHz, state.wireSampleRateHz);
  if (state.codec === "opus") return encodeOpusFrames(resampled, state, frameDurationMs, false);
  const encoded = state.codec === "g711_ulaw" ? encodePcm16ToMuLaw(resampled) : pcm16SamplesToBytes(resampled);
  const bytesPerSample = state.codec === "g711_ulaw" ? 1 : 2;
  const frameBytes = Math.max(1, Math.round((state.wireSampleRateHz * frameDurationMs) / 1000) * bytesPerSample);
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < encoded.byteLength; offset += frameBytes) {
    frames.push(encoded.subarray(offset, Math.min(encoded.byteLength, offset + frameBytes)));
  }
  return frames;
}

function encodePendingOpusFrame(state: SmartPbxConnectionState, frameDurationMs: number): Uint8Array[] {
  if (state.codec !== "opus" || state.opusEncodeRemainder.length === 0) return [];
  return encodeOpusFrames(new Int16Array(0), state, frameDurationMs, true);
}

function encodeOpusFrames(
  samples: Int16Array,
  state: SmartPbxConnectionState,
  frameDurationMs: number,
  flush: boolean,
): Uint8Array[] {
  if (!state.opusEncoder) throw new Error("SmartPBX opus encoder is not initialized");
  const frameSamples = Math.round((state.wireSampleRateHz * frameDurationMs) / 1000);
  const pending = new Int16Array(state.opusEncodeRemainder.length + samples.length);
  pending.set(state.opusEncodeRemainder);
  pending.set(samples, state.opusEncodeRemainder.length);
  const completeFrames = Math.floor(pending.length / frameSamples);
  const frames: Uint8Array[] = [];
  for (let index = 0; index < completeFrames; index += 1) {
    const frame = pending.subarray(index * frameSamples, (index + 1) * frameSamples);
    frames.push(state.opusEncoder.encode(pcm16SamplesToBytes(frame)));
  }
  const consumed = completeFrames * frameSamples;
  const remainder = pending.subarray(consumed);
  if (flush && remainder.length > 0) {
    const padded = new Int16Array(frameSamples);
    padded.set(remainder);
    frames.push(state.opusEncoder.encode(pcm16SamplesToBytes(padded)));
    state.opusEncodeRemainder = new Int16Array(0);
  } else {
    state.opusEncodeRemainder = new Int16Array(remainder);
  }
  return frames;
}

function defaultSmartPbxContextId(start: SmartPbxStartPayload): string {
  const callId = start.callId?.trim();
  if (callId) return `smartpbx-${callId}`;
  return `smartpbx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function sendSmartPbxError(
  socket: WebSocket,
  state: SmartPbxConnectionState,
  message: string,
  maxBufferedAmountBytes: number,
): void {
  sendSmartPbxJson(socket, {
    event: "syrinx_error",
    callId: state.callId || undefined,
    accountId: state.accountId || undefined,
    error: {
      component: "transport",
      category: "invalid_input",
      message,
    },
  }, maxBufferedAmountBytes);
}

function sendSmartPbxJson(socket: WebSocket, value: unknown, maxBufferedAmountBytes: number): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const data = JSON.stringify(value);
  if (socket.bufferedAmount + Buffer.byteLength(data, "utf8") > maxBufferedAmountBytes) {
    closeWebSocketWithFallback(socket, 1013, "websocket send buffer exceeded");
    return false;
  }
  socket.send(data);
  return true;
}
