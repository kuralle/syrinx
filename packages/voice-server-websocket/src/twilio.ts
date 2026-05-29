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
import { PacedPlayoutQueue, type PacedPlayoutFrame } from "./paced-playout.js";
import { closeWebSocketWithFallback } from "./websocket-close.js";
import { createRoutedWebSocketServer } from "./websocket-upgrade.js";

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
  readonly maxBufferedAmountBytes?: number;
  readonly maxInboundMessageBytes?: number;
}

export interface TwilioMediaStreamServer {
  readonly httpServer: HttpServer;
  readonly wsServer: WebSocketServer;
  address(): ReturnType<HttpServer["address"]>;
  close(): Promise<void>;
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
  readonly mark?: {
    readonly name?: string;
  };
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
}

interface PendingTwilioMessage {
  readonly data: RawData;
  readonly isBinary: boolean;
  readonly byteLength: number;
}

type TwilioPlayoutTerminationReason = "stop" | "disconnect" | "overflow" | "send_buffer";

const DEFAULT_ENGINE_SAMPLE_RATE_HZ = 16000;
const DEFAULT_TWILIO_SAMPLE_RATE_HZ = 8000;
const DEFAULT_OUTBOUND_FRAME_DURATION_MS = 20;
const DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 256 * 1024;
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export async function createTwilioMediaStreamServer(
  options: TwilioMediaStreamServerOptions,
): Promise<TwilioMediaStreamServer> {
  const ownsHttpServer = !options.server;
  const httpServer = options.server ?? createServer();
  const routedWebSocket = createRoutedWebSocketServer(httpServer, options.path ?? "/twilio");
  const wsServer = routedWebSocket.wsServer;
  const sessions = new Set<VoiceAgentSession>();
  const inputSampleRateHz = positiveInteger(options.inputSampleRateHz) ?? DEFAULT_ENGINE_SAMPLE_RATE_HZ;
  const outputSampleRateHz = positiveInteger(options.outputSampleRateHz) ?? DEFAULT_ENGINE_SAMPLE_RATE_HZ;
  const twilioSampleRateHz = positiveInteger(options.twilioSampleRateHz) ?? DEFAULT_TWILIO_SAMPLE_RATE_HZ;
  const outboundFrameDurationMs = positiveInteger(options.outboundFrameDurationMs) ?? DEFAULT_OUTBOUND_FRAME_DURATION_MS;
  const maxQueuedOutputAudioMs = positiveInteger(options.maxQueuedOutputAudioMs) ?? DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS;
  const heartbeatIntervalMs = nonNegativeInteger(options.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxBufferedAmountBytes = positiveInteger(options.maxBufferedAmountBytes) ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES;
  const maxInboundMessageBytes = positiveInteger(options.maxInboundMessageBytes) ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES;

  wsServer.on("connection", (socket, request) => {
    void handleTwilioConnection({
      socket,
      request,
      createSession: options.createSession,
      contextId: options.contextId ?? defaultTwilioContextId,
      sessions,
      inputSampleRateHz,
      outputSampleRateHz,
      twilioSampleRateHz,
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
      for (const client of wsServer.clients) {
        client.terminate();
      }
      for (const session of sessions) {
        await session.close().catch(() => undefined);
      }
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

async function handleTwilioConnection(args: {
  readonly socket: WebSocket;
  readonly request: IncomingMessage;
  readonly createSession: (request: IncomingMessage) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly contextId: (start: TwilioStartPayload) => string;
  readonly sessions: Set<VoiceAgentSession>;
  readonly inputSampleRateHz: number;
  readonly outputSampleRateHz: number;
  readonly twilioSampleRateHz: number;
  readonly outboundFrameDurationMs: number;
  readonly maxQueuedOutputAudioMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maxBufferedAmountBytes: number;
  readonly maxInboundMessageBytes: number;
}): Promise<void> {
  const {
    socket,
    request,
    createSession,
    contextId,
    sessions,
    inputSampleRateHz,
    outputSampleRateHz,
    twilioSampleRateHz,
    outboundFrameDurationMs,
    maxQueuedOutputAudioMs,
    heartbeatIntervalMs,
    maxBufferedAmountBytes,
    maxInboundMessageBytes,
  } = args;
  const state: TwilioConnectionState = {
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
  };
  const disposers: Array<() => void> = [];
  const pendingMessages: PendingTwilioMessage[] = [];
  let pendingMessageBytes = 0;
  let ready = false;
  let socketClosed = false;
  let clearPendingPlayout: (reason: TwilioPlayoutTerminationReason) => void = () => undefined;
  let session: VoiceAgentSession | null = null;

  const processMessage = (data: RawData, isBinary: boolean): void => {
    if (!session) return;
    if (isBinary) throw new Error("Twilio Media Streams messages must be JSON text frames");
    handleTwilioMessage({
      session,
      data,
      state,
      contextId,
      inputSampleRateHz,
      twilioSampleRateHz,
      onStop: () => clearPendingPlayout("stop"),
    });
  };

  const handleMessage = (data: RawData, isBinary: boolean): void => {
    try {
      const byteLength = rawDataByteLength(data);
      if (byteLength > maxInboundMessageBytes) {
        sendTwilioError(
          socket,
          state.streamSid,
          `Twilio websocket message exceeds maxInboundMessageBytes (${String(maxInboundMessageBytes)})`,
          maxBufferedAmountBytes,
        );
        socket.close(1009, "websocket message too large");
        return;
      }
      if (!ready) {
        pendingMessageBytes += byteLength;
        if (pendingMessageBytes > maxInboundMessageBytes) {
          sendTwilioError(
            socket,
            state.streamSid,
            `Pending Twilio websocket input exceeds maxInboundMessageBytes (${String(maxInboundMessageBytes)}) before session ready`,
            maxBufferedAmountBytes,
          );
          socket.close(1009, "websocket pending input too large");
          return;
        }
        pendingMessages.push({ data: cloneRawData(data), isBinary, byteLength });
        return;
      }
      processMessage(data, isBinary);
    } catch (err) {
      sendTwilioError(socket, state.streamSid, err instanceof Error ? err.message : String(err), maxBufferedAmountBytes);
    }
  };

  socket.on("message", handleMessage);

  socket.on("close", () => {
    socketClosed = true;
    clearPendingPlayout("disconnect");
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    if (session) {
      sessions.delete(session);
      void session.close().catch(() => undefined);
    }
  });

  try {
    session = await createSession(request);
    sessions.add(session);
    if (socketClosed) {
      sessions.delete(session);
      await session.close().catch(() => undefined);
      return;
    }
    startWebSocketHeartbeat(socket, heartbeatIntervalMs, disposers);
    clearPendingPlayout = wireTwilioSessionEvents({
      session,
      socket,
      state,
      disposers,
      outputSampleRateHz,
      twilioSampleRateHz,
      outboundFrameDurationMs,
      maxQueuedOutputAudioMs,
      maxBufferedAmountBytes,
    });
    await session.start();
    ready = true;
    for (const pending of pendingMessages.splice(0)) {
      pendingMessageBytes -= pending.byteLength;
      try {
        processMessage(pending.data, pending.isBinary);
      } catch (err) {
        sendTwilioError(socket, state.streamSid, err instanceof Error ? err.message : String(err), maxBufferedAmountBytes);
      }
    }
    pendingMessageBytes = 0;
  } catch (err) {
    sendTwilioError(socket, state.streamSid, err instanceof Error ? err.message : String(err), maxBufferedAmountBytes);
    socket.close(1011, "session initialization failed");
    return;
  }
}

function wireTwilioSessionEvents(args: {
  readonly session: VoiceAgentSession;
  readonly socket: WebSocket;
  readonly state: TwilioConnectionState;
  readonly disposers: Array<() => void>;
  readonly outputSampleRateHz: number;
  readonly twilioSampleRateHz: number;
  readonly outboundFrameDurationMs: number;
  readonly maxQueuedOutputAudioMs: number;
  readonly maxBufferedAmountBytes: number;
}): (reason: TwilioPlayoutTerminationReason) => void {
  const {
    session,
    socket,
    state,
    disposers,
    outputSampleRateHz,
    twilioSampleRateHz,
    outboundFrameDurationMs,
    maxQueuedOutputAudioMs,
    maxBufferedAmountBytes,
  } = args;
  const frameBytes = Math.max(1, Math.round((twilioSampleRateHz * outboundFrameDurationMs) / 1000));
  const recordDiscardedPlayout = (discardedMs: number, reason: TwilioPlayoutTerminationReason): void => {
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
      name: `twilio.${reason}_playout_cleared_ms`,
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
    if (state.stopped || !state.streamSid || !state.pendingEndMarkName || state.pendingMarks.size > 0) return;
    const markName = state.pendingEndMarkName;
    const sent = sendTwilioJson(socket, {
      event: "mark",
      streamSid: state.streamSid,
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
      const sent = !state.stopped
        && state.streamSid
        && sendTwilioJson(socket, { event: "clear", streamSid: state.streamSid }, maxBufferedAmountBytes);
      if (sent) {
        session.bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId: interrupt.contextId,
          timestampMs: Date.now(),
          name: "twilio.clear_sent",
          value: "1",
        });
      }
    }),
    session.bus.on("tts.audio", (pkt) => {
      const audioPacket = pkt as TextToSpeechAudioPacket;
      if (interruptedContextIds.has(audioPacket.contextId)) return;
      if (state.stopped || !state.streamSid || socket.readyState !== WebSocket.OPEN) return;
      const samples = pcm16BytesToSamples(audioPacket.audio);
      const resampled = resamplePcm16(samples, outputSampleRateHz, twilioSampleRateHz);
      const encoded = encodePcm16ToMuLaw(resampled);
      const frames: PacedPlayoutFrame[] = [];
      for (let offset = 0; offset < encoded.byteLength; offset += frameBytes) {
        const frame = encoded.subarray(offset, Math.min(encoded.byteLength, offset + frameBytes));
        frames.push({
          send: () => {
            if (state.stopped) return false;
            return sendTwilioJson(socket, {
              event: "media",
              streamSid: state.streamSid,
              media: {
                payload: Buffer.from(frame).toString("base64"),
              },
            }, maxBufferedAmountBytes);
          },
        });
      }
      state.outboundSequence += 1;
      const markName = `${audioPacket.contextId}:${String(state.outboundSequence)}`;
      const finalFrame = frames.at(-1);
      if (finalFrame) {
        frames[frames.length - 1] = {
          send: finalFrame.send,
          afterSend: () => {
            if (state.stopped) return;
            const sent = sendTwilioJson(socket, {
              event: "mark",
              streamSid: state.streamSid,
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
                name: "twilio.mark_sent",
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
      if (state.stopped || !state.streamSid) return;
      playout.enqueueControl(() => {
        if (state.stopped || !state.streamSid) return;
        state.pendingEndMarkName = `${end.contextId}:end`;
        sendPendingEndMark();
      });
    }),
  );

  return (reason) => {
    recordDiscardedPlayout(playout.clear(), reason);
  };
}

function handleTwilioMessage(args: {
  readonly session: VoiceAgentSession;
  readonly data: RawData;
  readonly state: TwilioConnectionState;
  readonly contextId: (start: TwilioStartPayload) => string;
  readonly inputSampleRateHz: number;
  readonly twilioSampleRateHz: number;
  readonly onStop: () => void;
}): void {
  const { session, data, state, contextId, inputSampleRateHz, twilioSampleRateHz, onStop } = args;
  const message = JSON.parse(rawDataToText(data)) as TwilioMediaMessage;
  const event = message.event;
  rememberTwilioSequenceNumber(session, state, message.sequenceNumber);

  if (event === "connected") return;
  if (event === "start") {
    if (state.stopped) throw new Error("Twilio start event received after stream stop");
    const start = message.start ?? {};
    validateTwilioStart(start, twilioSampleRateHz);
    state.streamSid = start.streamSid ?? message.streamSid ?? "";
    if (!state.streamSid) throw new Error("Twilio start event is missing streamSid");
    state.contextId = contextId(start);
    state.started = true;
    return;
  }
  if (event === "media") {
    if (state.stopped) return;
    if (!state.started || !state.contextId) {
      throw new Error("Twilio media event received before a valid start event");
    }
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
      name: "twilio.mark_received",
      value: markName,
    });
    return;
  }
  if (event === "dtmf") return;

  throw new Error(`Unsupported Twilio Media Streams event: ${String(event)}`);
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
  const validEncoding = encoding === "audio/x-mulaw"
    || encoding === "audio/mulaw"
    || encoding === "mulaw"
    || encoding === "mu-law"
    || encoding === "ulaw"
    || encoding === "pcmu"
    || encoding === "g711_ulaw";
  if (!validEncoding) {
    throw new Error(`Unsupported Twilio media encoding: ${format.encoding ?? "unknown"}`);
  }

  const sampleRate = numberFromString(format.sampleRate);
  if (sampleRate !== expectedSampleRateHz) {
    throw new Error(`Unsupported Twilio sample rate: ${String(format.sampleRate)}`);
  }

  const channels = numberFromString(format.channels);
  if (channels !== 1) {
    throw new Error(`Unsupported Twilio channel count: ${String(format.channels)}`);
  }
}

export function decodeMuLawToPcm16(input: Uint8Array): Int16Array {
  const output = new Int16Array(input.byteLength);
  for (let i = 0; i < input.byteLength; i += 1) {
    const ulaw = (~input[i]!) & 0xff;
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    output[i] = sign ? -sample : sample;
  }
  return output;
}

export function encodePcm16ToMuLaw(input: Int16Array): Uint8Array {
  const output = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = encodePcm16SampleToMuLaw(input[i]!);
  }
  return output;
}

export function resamplePcm16(input: Int16Array, sourceSampleRateHz: number, targetSampleRateHz: number): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (sourceSampleRateHz === targetSampleRateHz) return input;

  const outputSampleCount = Math.max(1, Math.round((input.length * targetSampleRateHz) / sourceSampleRateHz));
  const output = new Int16Array(outputSampleCount);
  const ratio = sourceSampleRateHz / targetSampleRateHz;
  for (let i = 0; i < output.length; i += 1) {
    const sourceIndex = i * ratio;
    const lo = Math.floor(sourceIndex);
    const hi = Math.min(input.length - 1, lo + 1);
    const frac = sourceIndex - lo;
    output[i] = Math.round(input[lo]! * (1 - frac) + input[hi]! * frac);
  }
  return output;
}

export function pcm16SamplesToBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.byteLength);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i]!, true);
  }
  return bytes;
}

export function pcm16BytesToSamples(audio: Uint8Array): Int16Array {
  if (audio.byteLength % 2 !== 0) {
    throw new Error("PCM16 audio payload must contain an even number of bytes");
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const samples = new Int16Array(audio.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return samples;
}

function encodePcm16SampleToMuLaw(sample: number): number {
  let sign = 0;
  let magnitude = sample;
  if (magnitude < 0) {
    sign = 0x80;
    magnitude = -magnitude;
  }
  magnitude = Math.min(magnitude, MULAW_CLIP) + MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function defaultTwilioContextId(start: TwilioStartPayload): string {
  const callSid = start.callSid?.trim();
  if (callSid) return `twilio-${callSid}`;
  const streamSid = start.streamSid?.trim();
  if (streamSid) return `twilio-${streamSid}`;
  return `twilio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty base64 string`);
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${fieldName} must be valid base64`);
  }
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function sendTwilioError(socket: WebSocket, streamSid: string, message: string, maxBufferedAmountBytes: number): void {
  sendTwilioJson(socket, {
    event: "syrinx_error",
    streamSid: streamSid || undefined,
    error: {
      component: "transport",
      category: "invalid_input",
      message,
    },
  }, maxBufferedAmountBytes);
}

function sendTwilioJson(socket: WebSocket, value: unknown, maxBufferedAmountBytes: number): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const data = JSON.stringify(value);
  if (socket.bufferedAmount + Buffer.byteLength(data, "utf8") > maxBufferedAmountBytes) {
    closeWebSocketWithFallback(socket, 1013, "websocket send buffer exceeded");
    return false;
  }
  socket.send(data);
  return true;
}

function startWebSocketHeartbeat(
  socket: WebSocket,
  heartbeatIntervalMs: number,
  disposers: Array<() => void>,
): void {
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
