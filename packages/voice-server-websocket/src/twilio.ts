// SPDX-License-Identifier: MIT

import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Route, type VoiceAgentSession } from "@asyncdot/voice";
import { decodeMuLawToPcm16, encodePcm16ToMuLaw, pcm16BytesToSamples, pcm16SamplesToBytes, resamplePcm16 } from "@asyncdot/voice/audio";
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
  optionalNonNegativeIntegerString,
  optionalPositiveIntegerString,
  positiveInteger,
  rawDataToText,
} from "./transport-helpers.js";

export interface TwilioMediaStreamServerOptions {
  readonly server?: HttpServer;
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  readonly createSession: (request: IncomingMessage) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly contextId?: (start: TwilioStartPayload) => string;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
  readonly twilioSampleRateHz?: number;
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

export interface TwilioMediaStreamServer {
  readonly httpServer: HttpServer;
  readonly wsServer: WebSocketServer;
  address(): ReturnType<HttpServer["address"]>;
  close(opts?: GracefulCloseOptions): Promise<void>;
}

export interface TwilioStartPayload {
  readonly streamSid?: string;
  readonly callSid?: string;
  readonly mediaFormat?: {
    readonly encoding?: string;
    readonly sampleRate?: number | string;
    readonly channels?: number | string;
  };
}

interface TwilioMediaMessage {
  readonly event?: string;
  readonly streamSid?: string;
  readonly sequenceNumber?: string;
  readonly start?: TwilioStartPayload;
  readonly media?: {
    readonly payload?: string;
    readonly track?: string;
    readonly chunk?: string;
    readonly timestamp?: string;
  };
  readonly mark?: { readonly name?: string };
}

interface TwilioConnectionState {
  streamSid: string;
  contextId: string;
  started: boolean;
  stopped: boolean;
  lastInboundSequenceNumber: number | null;
  lastInboundMediaChunk: number | null;
  lastInboundMediaTimestampMs: number | null;
  outboundSequence: number;
  pendingMarks: Set<string>;
  pendingEndMarkName: string;
  onPlaybackMarkReceived?: () => void;
  clearPlayout: (reason: string) => void;
}

const DEFAULT_ENGINE_SAMPLE_RATE_HZ = 16000;
const DEFAULT_TWILIO_SAMPLE_RATE_HZ = 8000;
const DEFAULT_OUTBOUND_FRAME_DURATION_MS = 20;
const DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SESSION_DURATION_MS = 30 * 60_000;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 256 * 1024;

export async function createTwilioMediaStreamServer(
  options: TwilioMediaStreamServerOptions,
): Promise<TwilioMediaStreamServer> {
  const ownsHttpServer = !options.server;
  const httpServer = options.server ?? createServer();
  const routedWebSocket = createRoutedWebSocketServer(httpServer, options.path ?? "/twilio", {
    maxConcurrentSessions: positiveInteger(options.maxConcurrentSessions) ?? undefined,
    maxConcurrentSessionsScope: options.maxConcurrentSessionsScope,
    onAdmissionRejected: () => options.onTransportMetric?.(TRANSPORT_ADMISSION_REJECTED_METRIC),
  });
  const wsServer = routedWebSocket.wsServer;
  const sessions = new Set<VoiceAgentSession>();
  const inputSampleRateHz = positiveInteger(options.inputSampleRateHz) ?? DEFAULT_ENGINE_SAMPLE_RATE_HZ;
  const twilioSampleRateHz = positiveInteger(options.twilioSampleRateHz) ?? DEFAULT_TWILIO_SAMPLE_RATE_HZ;
  const outboundFrameDurationMs = positiveInteger(options.outboundFrameDurationMs) ?? DEFAULT_OUTBOUND_FRAME_DURATION_MS;
  const maxQueuedOutputAudioMs = positiveInteger(options.maxQueuedOutputAudioMs) ?? DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS;
  const frameBytes = Math.max(1, Math.round((twilioSampleRateHz * outboundFrameDurationMs) / 1000));
  const hostConfig: TransportHostConfig = {
    heartbeatIntervalMs: nonNegativeInteger(options.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    startupTimeoutMs: nonNegativeInteger(options.startupTimeoutMs) ?? DEFAULT_STARTUP_TIMEOUT_MS,
    maxSessionDurationMs: nonNegativeInteger(options.maxSessionDurationMs) ?? DEFAULT_MAX_SESSION_DURATION_MS,
    maxBufferedAmountBytes: positiveInteger(options.maxBufferedAmountBytes) ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
    maxInboundMessageBytes: positiveInteger(options.maxInboundMessageBytes) ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES,
  };
  const contextIdFn = options.contextId ?? defaultTwilioContextId;
  const gracefulCloseRegistry = new Map<WebSocket, (deadlineMs: number) => Promise<void>>();

  const adapter: TransportAdapter<TwilioConnectionState> = {
    createState: () => ({
      streamSid: "",
      contextId: "",
      started: false,
      stopped: false,
      lastInboundSequenceNumber: null,
      lastInboundMediaChunk: null,
      lastInboundMediaTimestampMs: null,
      outboundSequence: 0,
      pendingMarks: new Set(),
      pendingEndMarkName: "",
      clearPlayout: () => undefined,
    }),

    async acquireSession({ request, shouldAbort, onSessionCreated }) {
      const sess = await options.createSession(request);
      onSessionCreated(sess);
      if (shouldAbort()) {
        await sess.close().catch(() => undefined);
        throw new Error("Twilio websocket session startup aborted");
      }
      sessions.add(sess);
      await sess.start();
      if (shouldAbort()) {
        sessions.delete(sess);
        await sess.close().catch(() => undefined);
        throw new Error("Twilio websocket session startup aborted");
      }
      return { session: sess, resumed: false };
    },

    wireSession(session, socket, state, disposers) {
      const sendPendingEndMark = (): void => {
        if (state.stopped || !state.streamSid || !state.pendingEndMarkName || state.pendingMarks.size > 0) return;
        const markName = state.pendingEndMarkName;
        const sent = sendTwilioJson(socket, {
          event: "mark",
          streamSid: state.streamSid,
          mark: { name: markName },
        }, hostConfig.maxBufferedAmountBytes);
        if (sent) state.pendingEndMarkName = "";
      };
      state.onPlaybackMarkReceived = sendPendingEndMark;

      const outbound = wireTelephonyOutboundPipeline({
        session,
        socket,
        disposers,
        outboundFrameDurationMs,
        maxQueuedOutputAudioMs,
        callbacks: {
          carrierLabel: "twilio",
          getContextId: () => state.contextId,
          isActive: () => !state.stopped && !!state.streamSid,
          encodeFrames: (audio, sourceSampleRateHz, contextId) => {
            const samples = pcm16BytesToSamples(audio);
            const resampled = resamplePcm16(samples, sourceSampleRateHz, twilioSampleRateHz);
            const encoded = encodePcm16ToMuLaw(resampled);
            const frames = [];
            for (let offset = 0; offset < encoded.byteLength; offset += frameBytes) {
              const frame = encoded.subarray(offset, Math.min(encoded.byteLength, offset + frameBytes));
              frames.push({
                contextId,
                send: () => {
                  if (state.stopped) return false;
                  return sendTwilioJson(socket, {
                    event: "media",
                    streamSid: state.streamSid,
                    media: { payload: Buffer.from(frame).toString("base64") },
                  }, hostConfig.maxBufferedAmountBytes);
                },
              });
            }
            state.outboundSequence += 1;
            const markName = `${contextId}:${String(state.outboundSequence)}`;
            const finalFrame = frames.at(-1);
            if (finalFrame) {
              frames[frames.length - 1] = {
                contextId,
                send: finalFrame.send,
                afterSend: () => {
                  if (state.stopped) return;
                  const sent = sendTwilioJson(socket, {
                    event: "mark",
                    streamSid: state.streamSid,
                    mark: { name: markName },
                  }, hostConfig.maxBufferedAmountBytes);
                  if (sent) {
                    state.pendingMarks.add(markName);
                    session.bus.push(Route.Background, {
                      kind: "metric.conversation",
                      contextId,
                      timestampMs: Date.now(),
                      name: "twilio.mark_sent",
                      value: markName,
                    });
                  }
                },
              };
            }
            return frames;
          },
          onInterrupt: (contextId) => {
            state.pendingMarks.clear();
            state.pendingEndMarkName = "";
            const sent = !state.stopped && !!state.streamSid && sendTwilioJson(socket, {
              event: "clear",
              streamSid: state.streamSid,
            }, hostConfig.maxBufferedAmountBytes);
            if (sent) {
              session.bus.push(Route.Background, {
                kind: "metric.conversation",
                contextId,
                timestampMs: Date.now(),
                name: "twilio.clear_sent",
                value: "1",
              });
            }
          },
          onDrain: (contextId, playout, progress) => {
            playout.enqueueControl(() => {
              if (state.stopped || !state.streamSid) return;
              progress.complete(contextId);
              state.pendingEndMarkName = `${contextId}:end`;
              sendPendingEndMark();
            });
          },
          onStop: () => { state.stopped = true; },
        },
      });
      state.clearPlayout = outbound.clearPlayout;
      gracefulCloseRegistry.set(socket, (deadlineMs) => outbound.drainAndClose(socket, deadlineMs));
      disposers.push(() => gracefulCloseRegistry.delete(socket));
      return (reason) => state.clearPlayout(reason);
    },

    processMessage(data, isBinary, session, state) {
      if (isBinary) throw new Error("Twilio Media Streams messages must be JSON text frames");
      const message = parseTwilioMessage(parseJsonRecord(rawDataToText(data), "Twilio Media Streams message"));
      const event = message.event;
      rememberTwilioSequenceNumber(session, state, message.sequenceNumber);

      if (event === "connected") return;
      if (event === "start") {
        if (state.stopped) throw new Error("Twilio start event received after stream stop");
        const start = message.start ?? {};
        validateTwilioStart(start, twilioSampleRateHz);
        state.streamSid = start.streamSid ?? message.streamSid ?? "";
        if (!state.streamSid) throw new Error("Twilio start event is missing streamSid");
        state.contextId = contextIdFn(start);
        state.started = true;
        return;
      }
      if (event === "media") {
        if (state.stopped) return;
        if (!state.started || !state.contextId) throw new Error("Twilio media event received before a valid start event");
        const payload = message.media?.payload;
        if (!payload) throw new Error("Twilio media event is missing media.payload");
        rememberTwilioMediaChunk(session, state, message.media?.chunk);
        const ulaw = decodeStrictBase64(payload, "media.payload");
        const pcm8k = decodeMuLawToPcm16(ulaw);
        rememberTwilioMediaTimestamp(session, state, message.media?.timestamp, pcm8k.length, twilioSampleRateHz);
        const pcm16k = resamplePcm16(pcm8k, twilioSampleRateHz, inputSampleRateHz);
        session.bus.push(Route.Main, {
          kind: "user.audio_received",
          contextId: state.contextId,
          timestampMs: Date.now(),
          audio: pcm16SamplesToBytes(pcm16k),
        });
        return;
      }
      if (event === "stop") {
        state.stopped = true;
        state.started = false;
        state.pendingMarks.clear();
        state.clearPlayout("stop");
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
          name: "twilio.mark_received",
          value: markName,
        });
        return;
      }
      if (event === "dtmf") return;
      throw new Error(`Unsupported Twilio Media Streams event: ${String(event)}`);
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
      sendTwilioError(socket, state.streamSid, message, hostConfig.maxBufferedAmountBytes);
    },

    sendStartupError(socket, state, err) {
      sendTwilioError(socket, state.streamSid, err instanceof Error ? err.message : String(err), hostConfig.maxBufferedAmountBytes);
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

function parseTwilioMessage(value: Record<string, unknown>): TwilioMediaMessage {
  const start = optionalRecord(value.start, "Twilio start");
  const media = optionalRecord(value.media, "Twilio media");
  const mark = optionalRecord(value.mark, "Twilio mark");
  const mediaFormat = optionalRecord(start?.mediaFormat, "Twilio start.mediaFormat");
  return {
    event: requiredString(value.event, "Twilio event"),
    streamSid: optionalString(value.streamSid, "Twilio streamSid"),
    sequenceNumber: optionalString(value.sequenceNumber, "Twilio sequenceNumber"),
    start: start
      ? {
          streamSid: optionalString(start.streamSid, "Twilio start.streamSid"),
          callSid: optionalString(start.callSid, "Twilio start.callSid"),
          mediaFormat: mediaFormat
            ? {
                encoding: optionalString(mediaFormat.encoding, "Twilio start.mediaFormat.encoding"),
                sampleRate: optionalStringOrNumber(mediaFormat.sampleRate, "Twilio start.mediaFormat.sampleRate"),
                channels: optionalStringOrNumber(mediaFormat.channels, "Twilio start.mediaFormat.channels"),
              }
            : undefined,
        }
      : undefined,
    media: media
      ? {
          payload: optionalString(media.payload, "Twilio media.payload"),
          track: optionalString(media.track, "Twilio media.track"),
          chunk: optionalString(media.chunk, "Twilio media.chunk"),
          timestamp: optionalString(media.timestamp, "Twilio media.timestamp"),
        }
      : undefined,
    mark: mark ? { name: optionalString(mark.name, "Twilio mark.name") } : undefined,
  };
}

function rememberTwilioSequenceNumber(
  session: VoiceAgentSession,
  state: TwilioConnectionState,
  sequenceValue: string | undefined,
): void {
  const sequence = optionalPositiveIntegerString(sequenceValue, "Twilio sequenceNumber");
  if (sequence === undefined) return;
  const previous = state.lastInboundSequenceNumber;
  if (previous !== null && sequence <= previous) {
    throw new Error(`Twilio sequenceNumber must increase monotonically: ${String(previous)} -> ${String(sequence)}`);
  }
  if (previous !== null && sequence > previous + 1) {
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: "twilio.sequence_gap",
      value: JSON.stringify({ expected: previous + 1, actual: sequence, missed: sequence - previous - 1 }),
    });
  }
  state.lastInboundSequenceNumber = sequence;
}

function rememberTwilioMediaChunk(
  session: VoiceAgentSession,
  state: TwilioConnectionState,
  chunkValue: string | undefined,
): void {
  const chunk = optionalPositiveIntegerString(chunkValue, "Twilio media.chunk");
  if (chunk === undefined) return;
  const previous = state.lastInboundMediaChunk;
  if (previous !== null && chunk <= previous) {
    throw new Error(`Twilio media.chunk must increase monotonically: ${String(previous)} -> ${String(chunk)}`);
  }
  if (previous !== null && chunk > previous + 1) {
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: "twilio.media_chunk_gap",
      value: JSON.stringify({ expected: previous + 1, actual: chunk, missed: chunk - previous - 1 }),
    });
  }
  state.lastInboundMediaChunk = chunk;
}

function rememberTwilioMediaTimestamp(
  session: VoiceAgentSession,
  state: TwilioConnectionState,
  timestampValue: string | undefined,
  sampleCount: number,
  sampleRateHz: number,
): void {
  const timestampMs = optionalNonNegativeIntegerString(timestampValue, "Twilio media.timestamp");
  if (timestampMs === undefined) return;
  const previous = state.lastInboundMediaTimestampMs;
  if (previous !== null && timestampMs < previous) {
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: state.contextId,
      timestampMs: Date.now(),
      name: "twilio.media_timestamp_regression",
      value: JSON.stringify({ previous, actual: timestampMs }),
    });
  } else if (previous !== null) {
    const expected = previous + Math.round((sampleCount / sampleRateHz) * 1000);
    if (timestampMs > expected) {
      session.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: state.contextId,
        timestampMs: Date.now(),
        name: "twilio.media_timestamp_gap",
        value: JSON.stringify({ expected, actual: timestampMs, missedMs: timestampMs - expected }),
      });
    }
  }
  state.lastInboundMediaTimestampMs = timestampMs;
}

function validateTwilioStart(start: TwilioStartPayload, expectedSampleRateHz: number): void {
  const format = start.mediaFormat;
  if (!format) throw new Error("Twilio start event is missing mediaFormat");
  const encoding = format.encoding?.trim().toLowerCase();
  const validEncoding = encoding === "audio/x-mulaw" || encoding === "audio/mulaw"
    || encoding === "mulaw" || encoding === "mu-law" || encoding === "ulaw"
    || encoding === "pcmu" || encoding === "g711_ulaw";
  if (!validEncoding) throw new Error(`Unsupported Twilio media encoding: ${format.encoding ?? "unknown"}`);
  const sampleRate = numberFromString(format.sampleRate);
  if (sampleRate !== expectedSampleRateHz) throw new Error(`Unsupported Twilio sample rate: ${String(format.sampleRate)}`);
  const channels = numberFromString(format.channels);
  if (channels !== 1) throw new Error(`Unsupported Twilio channel count: ${String(format.channels)}`);
}

function defaultTwilioContextId(start: TwilioStartPayload): string {
  const callSid = start.callSid?.trim();
  if (callSid) return `twilio-${callSid}`;
  const streamSid = start.streamSid?.trim();
  if (streamSid) return `twilio-${streamSid}`;
  return `twilio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sendTwilioError(socket: WebSocket, streamSid: string, message: string, maxBufferedAmountBytes: number): void {
  sendTwilioJson(socket, {
    event: "syrinx_error",
    streamSid: streamSid || undefined,
    error: { component: "transport", category: "invalid_input", message },
  }, maxBufferedAmountBytes);
}

function sendTwilioJson(socket: WebSocket, value: unknown, maxBufferedAmountBytes: number): boolean {
  return sendJsonCapped(socket, value, maxBufferedAmountBytes);
}
