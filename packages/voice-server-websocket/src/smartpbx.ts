// SPDX-License-Identifier: MIT

import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from "@evan/opus";
import { Route, type VoiceAgentSession } from "@asyncdot/voice";
import {
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
  pcm16BytesToSamples,
  pcm16SamplesToBytes,
  resamplePcm16Streaming,
  type StreamingPcm16Resampler,
} from "@asyncdot/voice/audio";
import { sendJsonCapped } from "./websocket-close.js";
import {
  optionalRecord,
  optionalString,
  optionalStringOrNumber,
  parseJsonRecord,
  requiredString,
} from "./json-message.js";
import { createRoutedWebSocketServer } from "./websocket-upgrade.js";
import { runWebSocketConnection, type GracefulCloseOptions, type TransportAdapter, type TransportHostConfig, TRANSPORT_ADMISSION_REJECTED_METRIC } from "./transport-host.js";
import { wireTelephonyOutboundPipeline } from "./outbound-playout-pipeline.js";
import {
  decodeStrictBase64,
  nonNegativeInteger,
  numberFromString,
  positiveInteger,
  rawDataToText,
} from "./transport-helpers.js";

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
  readonly maxConcurrentSessions?: number;
  readonly maxConcurrentSessionsScope?: "path" | "server";
  readonly onTransportMetric?: (name: string) => void;
}

export interface SmartPbxMediaStreamServer {
  readonly httpServer: HttpServer;
  readonly wsServer: WebSocketServer;
  address(): ReturnType<HttpServer["address"]>;
  close(opts?: GracefulCloseOptions): Promise<void>;
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
  readonly media?: { readonly payload?: string };
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
  clearPlayout: (reason: string) => void;
  readonly streamingResamplers: Map<string, StreamingPcm16Resampler>;
}

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
  const routedWebSocket = createRoutedWebSocketServer(httpServer, options.path ?? "/media-stream", {
    maxConcurrentSessions: positiveInteger(options.maxConcurrentSessions) ?? undefined,
    maxConcurrentSessionsScope: options.maxConcurrentSessionsScope,
    onAdmissionRejected: () => options.onTransportMetric?.(TRANSPORT_ADMISSION_REJECTED_METRIC),
  });
  const wsServer = routedWebSocket.wsServer;
  const sessions = new Set<VoiceAgentSession>();
  const inputSampleRateHz = positiveInteger(options.inputSampleRateHz) ?? DEFAULT_ENGINE_SAMPLE_RATE_HZ;
  const outboundFrameDurationMs = positiveInteger(options.outboundFrameDurationMs) ?? DEFAULT_OUTBOUND_FRAME_DURATION_MS;
  const maxQueuedOutputAudioMs = positiveInteger(options.maxQueuedOutputAudioMs) ?? DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS;
  const hostConfig: TransportHostConfig = {
    heartbeatIntervalMs: nonNegativeInteger(options.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    startupTimeoutMs: nonNegativeInteger(options.startupTimeoutMs) ?? DEFAULT_STARTUP_TIMEOUT_MS,
    maxSessionDurationMs: nonNegativeInteger(options.maxSessionDurationMs) ?? DEFAULT_MAX_SESSION_DURATION_MS,
    maxBufferedAmountBytes: positiveInteger(options.maxBufferedAmountBytes) ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
    maxInboundMessageBytes: positiveInteger(options.maxInboundMessageBytes) ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES,
  };
  const contextIdFn = options.contextId ?? defaultSmartPbxContextId;
  const gracefulCloseRegistry = new Map<WebSocket, (deadlineMs: number) => Promise<void>>();

  const adapter: TransportAdapter<SmartPbxConnectionState> = {
    createState: () => ({
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
      clearPlayout: () => undefined,
      streamingResamplers: new Map(),
    }),

    async acquireSession({ request, shouldAbort, onSessionCreated }) {
      const sess = await options.createSession(request);
      onSessionCreated(sess);
      if (shouldAbort()) {
        await sess.close().catch(() => undefined);
        throw new Error("SmartPBX websocket session startup aborted");
      }
      sessions.add(sess);
      await sess.start();
      if (shouldAbort()) {
        sessions.delete(sess);
        await sess.close().catch(() => undefined);
        throw new Error("SmartPBX websocket session startup aborted");
      }
      return { session: sess, resumed: false };
    },

    wireSession(session, socket, state, disposers) {
      const outbound = wireTelephonyOutboundPipeline({
        session,
        socket,
        disposers,
        outboundFrameDurationMs,
        maxQueuedOutputAudioMs,
        callbacks: {
          carrierLabel: "smartpbx",
          getContextId: () => state.contextId,
          isActive: () => !state.stopped && state.started,
          encodeFrames: (audio, sourceSampleRateHz, contextId) => {
            return encodeOutboundFrames(audio, sourceSampleRateHz, state, outboundFrameDurationMs)
              .map((frame) => ({
                contextId,
                send: () => {
                  if (state.stopped) return false;
                  return sendSmartPbxJson(socket, {
                    event: "media",
                    callId: state.callId,
                    accountId: state.accountId,
                    media: { payload: Buffer.from(frame).toString("base64") },
                  }, hostConfig.maxBufferedAmountBytes);
                },
              }));
          },
          onInterrupt: (contextId) => {
            session.bus.push(Route.Background, {
              kind: "metric.conversation",
              contextId,
              timestampMs: Date.now(),
              name: "smartpbx.interrupt_no_playback_clear",
              value: "1",
            });
          },
          onDrain: (contextId, playout, progress) => {
            const pendingFrames = encodePendingOpusFrame(state, outboundFrameDurationMs)
              .map((frame) => ({
                contextId,
                send: () => {
                  if (state.stopped) return false;
                  return sendSmartPbxJson(socket, {
                    event: "media",
                    callId: state.callId,
                    accountId: state.accountId,
                    media: { payload: Buffer.from(frame).toString("base64") },
                  }, hostConfig.maxBufferedAmountBytes);
                },
              }));
            playout.enqueue(pendingFrames);
            playout.enqueueControl(() => {
              if (state.stopped) return;
              progress.complete(contextId);
              session.bus.push(Route.Background, {
                kind: "metric.conversation",
                contextId,
                timestampMs: Date.now(),
                name: "smartpbx.playout_drained",
                value: "1",
              });
            });
          },
          onStop: (reason) => {
            state.stopped = true;
            if (reason === "send_buffer") state.opusEncodeRemainder = new Int16Array(0);
          },
          onClear: () => { state.opusEncodeRemainder = new Int16Array(0); },
        },
      });
      state.clearPlayout = outbound.clearPlayout;
      gracefulCloseRegistry.set(socket, (deadlineMs) => outbound.drainAndClose(socket, deadlineMs));
      disposers.push(() => gracefulCloseRegistry.delete(socket));
      return (reason) => {
        state.opusEncodeRemainder = new Int16Array(0);
        state.clearPlayout(reason);
      };
    },

    processMessage(data, isBinary, session, state) {
      if (isBinary) throw new Error("SmartPBX AI Provider messages must be JSON text frames");
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
        state.contextId = contextIdFn(start);
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
        const resampled = resamplePcm16Streaming(state.streamingResamplers, decoded, state.wireSampleRateHz, inputSampleRateHz);
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
        state.clearPlayout("stop");
        session.close().catch(() => undefined);
        return;
      }
      if (message.event === "dtmf") return;
      throw new Error(`Unsupported SmartPBX AI Provider event: ${String(message.event)}`);
    },

    onDisconnect(session) {
      sessions.delete(session);
      void session.close().catch(() => undefined);
    },

    onStartupTimeout(_state, session) {
      sessions.delete(session);
      void session.close().catch(() => undefined);
    },

    sendError(socket, state, message) {
      sendSmartPbxError(socket, state, message, hostConfig.maxBufferedAmountBytes);
    },

    sendStartupError(socket, state, err) {
      sendSmartPbxError(socket, state, err instanceof Error ? err.message : String(err), hostConfig.maxBufferedAmountBytes);
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

  let closing = false;
  return {
    httpServer,
    wsServer,
    address: () => httpServer.address(),
    close: async (opts) => {
      if (closing) return;
      closing = true;
      if (opts?.graceful === true && gracefulCloseRegistry.size > 0) {
        const deadline = Date.now() + (opts.drainDeadlineMs ?? 10_000);
        await Promise.allSettled(
          [...gracefulCloseRegistry.values()].map((fn) => fn(deadline)),
        );
        for (const client of wsServer.clients) {
          if (client.readyState === WebSocket.OPEN) client.terminate();
        }
      } else {
        for (const client of wsServer.clients) client.terminate();
      }
      gracefulCloseRegistry.clear();
      for (const session of sessions) await session.close().catch(() => undefined);
      await new Promise<void>((resolveClose) => { wsServer.close(() => resolveClose()); });
      routedWebSocket.detach();
      if (ownsHttpServer || typeof options.port === "number") {
        await new Promise<void>((resolveClose) => { httpServer.close(() => resolveClose()); });
      }
    },
  };
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
    media: media ? { payload: optionalString(media.payload, "SmartPBX media.payload") } : undefined,
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
  if (encoding === "g711_ulaw" && sampleRateHz !== 8000) throw new Error(`Unsupported SmartPBX g711_ulaw sample rate: ${String(format.sampleRate)}`);
  if (encoding === "pcm16" && sampleRateHz !== 24000) throw new Error(`Unsupported SmartPBX pcm16 sample rate: ${String(format.sampleRate)}`);
  if (encoding === "opus" && sampleRateHz !== 48000) throw new Error(`Unsupported SmartPBX opus sample rate: ${String(format.sampleRate)}`);
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
  const resampled = resamplePcm16Streaming(state.streamingResamplers, samples, sourceSampleRateHz, state.wireSampleRateHz);
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
    error: { component: "transport", category: "invalid_input", message },
  }, maxBufferedAmountBytes);
}

function sendSmartPbxJson(socket: WebSocket, value: unknown, maxBufferedAmountBytes: number): boolean {
  return sendJsonCapped(socket, value, maxBufferedAmountBytes);
}
