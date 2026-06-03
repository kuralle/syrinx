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
import {
  pcm16BytesToSamples,
  pcm16SamplesToBytes,
  resamplePcm16Streaming,
  type StreamingPcm16Resampler,
} from "@asyncdot/voice/audio";
import {
  BROWSER_OPUS_FRAME_DURATION_MS,
  BROWSER_OPUS_SAMPLE_RATE_HZ,
  createBrowserOpusCodec,
  decodeBrowserOpusToPcm16Bytes,
  type BrowserOpusCodec,
} from "./browser-opus.js";
import { closeWebSocketWithFallback, waitForWebSocketClose } from "./websocket-close.js";
import { isRecord, parseJsonRecord, optionalString, requiredString } from "./json-message.js";
import { createRoutedWebSocketServer } from "./websocket-upgrade.js";
import { runWebSocketConnection, type GracefulCloseOptions, type TransportAdapter, type TransportHostConfig, TRANSPORT_ADMISSION_REJECTED_METRIC } from "./transport-host.js";
import { wireTelephonyOutboundPipeline, type TelephonyOutboundCallbacks, type TelephonyOutboundHandle } from "./outbound-playout-pipeline.js";
import { TurnMetricsTracker, type TurnTimestampState } from "./turn-metrics.js";
import { type PacedPlayoutFrame } from "./paced-playout.js";
import {
  InMemorySessionStore,
  type AudioSequenceState,
  type ManagedSession,
  type SessionStore,
} from "./session-store.js";
import {
  decodeStrictBase64,
  nonNegativeInteger,
  positiveInteger,
  rawDataToText,
} from "./transport-helpers.js";

export * from "./twilio.js";
export * from "./telnyx.js";
export * from "./smartpbx.js";
export * from "./session-store.js";

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
  readonly outboundFrameDurationMs?: number;
  readonly maxQueuedOutputAudioMs?: number;
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
  /**
   * When true (default), outbound browser assistant audio is Opus inside the Syrinx
   * envelope. Set false only for tests or legacy clients that require PCM envelopes.
   */
  readonly browserOpusDownlink?: boolean;
  readonly sessionStore?: SessionStore;
  readonly maxConcurrentSessions?: number;
  readonly maxConcurrentSessionsScope?: "path" | "server";
  readonly onTransportMetric?: (name: string) => void;
}

export type { GracefulCloseOptions } from "./transport-host.js";

export interface VoiceWebSocketServer {
  readonly httpServer: HttpServer;
  readonly wsServer: WebSocketServer;
  address(): ReturnType<HttpServer["address"]>;
  close(opts?: GracefulCloseOptions): Promise<void>;
}

type ClientMessage =
  | { readonly type: "text"; readonly text: string; readonly contextId?: string }
  | {
      readonly type: "client_interrupt";
      readonly assistantContextId?: string;
      readonly contextId?: string;
      readonly reason?: string;
    }
  | {
      readonly type: "audio";
      readonly audio: string;
      readonly contextId?: string;
      readonly sampleRateHz: number;
      readonly sequence?: number;
    }
  | { readonly type: "codec_capability"; readonly downlinkEncoding: "pcm_s16le" | "opus" }
  | { readonly type: "ping" };

interface BrowserConnectionState {
  managed: ManagedSession | null;
  readonly initialContextId: string;
  outboundHandle: TelephonyOutboundHandle | null;
  opusCodec: BrowserOpusCodec | null;
  browserOpusDownlink: boolean;
  readonly streamingResamplers: Map<string, StreamingPcm16Resampler>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SESSION_DURATION_MS = 30 * 60_000;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESUME_WINDOW_MS = 15_000;
const DEFAULT_OUTBOUND_FRAME_DURATION_MS = 20;
const DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS = 30_000;

export async function createVoiceWebSocketServer(
  options: VoiceWebSocketServerOptions,
): Promise<VoiceWebSocketServer> {
  const ownsHttpServer = !options.server;
  const httpServer = options.server ?? createServer();
  const routedWebSocket = createRoutedWebSocketServer(httpServer, options.path ?? "/ws", {
    maxConcurrentSessions: positiveInteger(options.maxConcurrentSessions) ?? undefined,
    maxConcurrentSessionsScope: options.maxConcurrentSessionsScope,
    onAdmissionRejected: () => options.onTransportMetric?.(TRANSPORT_ADMISSION_REJECTED_METRIC),
  });
  const wsServer = routedWebSocket.wsServer;
  const sessionStore = options.sessionStore ?? new InMemorySessionStore();
  const sessionIdFn = options.sessionId ?? defaultSessionId;
  const contextIdFn = options.contextId ?? defaultContextId;
  const inputSampleRateHz = positiveInteger(options.inputSampleRateHz) ?? 16000;
  const outputSampleRateHz = positiveInteger(options.outputSampleRateHz) ?? 16000;
  const rawBinaryInput = options.rawBinaryInput ?? false;
  const binaryAudioEnvelope = options.binaryAudioEnvelope ?? true;
  const browserOpusDownlink = options.browserOpusDownlink ?? true;
  const resumeWindowMs = nonNegativeInteger(options.resumeWindowMs) ?? DEFAULT_RESUME_WINDOW_MS;
  const outboundFrameDurationMs = positiveInteger(options.outboundFrameDurationMs) ?? DEFAULT_OUTBOUND_FRAME_DURATION_MS;
  const maxQueuedOutputAudioMs = positiveInteger(options.maxQueuedOutputAudioMs) ?? DEFAULT_MAX_QUEUED_OUTPUT_AUDIO_MS;
  const hostConfig: TransportHostConfig = {
    heartbeatIntervalMs: nonNegativeInteger(options.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    startupTimeoutMs: nonNegativeInteger(options.startupTimeoutMs) ?? DEFAULT_STARTUP_TIMEOUT_MS,
    maxSessionDurationMs: nonNegativeInteger(options.maxSessionDurationMs) ?? DEFAULT_MAX_SESSION_DURATION_MS,
    maxBufferedAmountBytes: positiveInteger(options.maxBufferedAmountBytes) ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
    maxInboundMessageBytes: positiveInteger(options.maxInboundMessageBytes) ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES,
  };
  const gracefulCloseRegistry = new Map<WebSocket, (deadlineMs: number) => Promise<void>>();

  const adapter: TransportAdapter<BrowserConnectionState> = {
    createState: () => ({
      managed: null,
      initialContextId: contextIdFn(),
      outboundHandle: null,
      opusCodec: null,
      browserOpusDownlink: browserOpusDownlink,
      streamingResamplers: new Map(),
    }),

    async acquireSession({ request, state, shouldAbort, onSessionCreated }) {
      const requestedSessionId = sanitizeSessionId(sessionIdFromRequest(request) ?? sessionIdFn(request));
      const leased = await sessionStore.lease(requestedSessionId, async () => {
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
      });
      state.managed = leased.managed;
      return { session: leased.managed.session, resumed: leased.resumed };
    },

    wireSession(session, socket, state, disposers) {
      const managed = state.managed;
      if (!managed) throw new Error("websocket session missing managed state");
      state.opusCodec = createBrowserOpusCodec(BROWSER_OPUS_SAMPLE_RATE_HZ);
      state.outboundHandle = wireBrowserSessionEvents(
        session,
        socket,
        disposers,
        outputSampleRateHz,
        binaryAudioEnvelope,
        hostConfig.maxBufferedAmountBytes,
        outboundFrameDurationMs,
        maxQueuedOutputAudioMs,
        state.opusCodec,
        inputSampleRateHz,
        () => state.browserOpusDownlink,
        managed.turnMetricsTurns,
        state.streamingResamplers,
      );
      gracefulCloseRegistry.set(socket, (deadlineMs) => {
        if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
          return Promise.resolve();
        }
        if (state.outboundHandle) {
          return state.outboundHandle.drainAndClose(socket, deadlineMs);
        }
        return new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => { if (!settled) { settled = true; resolve(); } };
          const deadlineTimer = setTimeout(() => {
            if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
              socket.terminate();
            }
            settle();
          }, Math.max(0, deadlineMs - Date.now()));
          (deadlineTimer as NodeJS.Timeout).unref?.();
          socket.once("close", () => { clearTimeout(deadlineTimer); settle(); });
          closeWebSocketWithFallback(socket, 1001, "server going away");
        });
      });
      disposers.push(() => gracefulCloseRegistry.delete(socket));
      return () => undefined;
    },

    processMessage(data, isBinary, session, state) {
      if (!state.managed) return;
      const managed = state.managed;
      sessionStore.update(managed.id, (stored) => {
        stored.currentContextId = handleClientMessage(
          session,
          data,
          isBinary,
          stored.currentContextId,
          contextIdFn,
          inputSampleRateHz,
          rawBinaryInput,
          stored.contextSampleRates,
          stored.inputSequence,
          state.opusCodec,
          inputSampleRateHz,
          state,
          state.streamingResamplers,
        );
      });
    },

    onDisconnect(_session, state, { maxSessionTimedOut }) {
      if (state.managed) {
        state.managed.connectionCount = Math.max(0, state.managed.connectionCount - 1);
        void sessionStore.release(state.managed.id, maxSessionTimedOut ? 0 : resumeWindowMs);
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
          encoding: "opus",
          supportedInputCodecs: ["pcm_s16le", "opus"],
          channels: 1,
          targetFrameDurationMs: outboundFrameDurationMs,
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
        await Promise.allSettled(
          [...wsServer.clients].map((client) => waitForWebSocketClose(client, 250)),
        );
      } else {
        for (const client of wsServer.clients) client.terminate();
      }
      gracefulCloseRegistry.clear();
      for (const managed of await sessionStore.listAll()) {
        if (managed.closeTimer) clearTimeout(managed.closeTimer);
        await managed.session.close().catch(() => undefined);
      }
      await sessionStore.clear();
      // Force-terminate any remaining sockets before wsServer.close() so the
      // close event fires promptly even if a graceful handshake stalled.
      for (const client of wsServer.clients) client.terminate();
      // Yield one macrotask tick so pending net.Socket close events (from terminate()
      // or WS close handshake) are processed before wsServer.close() checks clients.
      await new Promise<void>((res) => setTimeout(res, 0));
      await new Promise<void>((resolveClose) => { wsServer.close(() => resolveClose()); });
      routedWebSocket.detach();
      if (ownsHttpServer || typeof options.port === "number") {
        await new Promise<void>((resolveClose) => { httpServer.close(() => resolveClose()); });
      }
    },
  };
}

function wireBrowserSessionEvents(
  session: VoiceAgentSession,
  socket: WebSocket,
  disposers: Array<() => void>,
  outputSampleRateHz: number,
  binaryAudioEnvelope: boolean,
  maxBufferedAmountBytes: number,
  outboundFrameDurationMs: number,
  maxQueuedOutputAudioMs: number,
  opusCodec: BrowserOpusCodec | null,
  engineInputSampleRateHz: number,
  getBrowserOpusDownlink: () => boolean,
  turnMetricsTurns: Map<string, TurnTimestampState>,
  streamingResamplers: Map<string, StreamingPcm16Resampler>,
): TelephonyOutboundHandle {
  const ttsSequences = new Map<string, number>();
  let currentContextId = "";

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
  disposers.push(
    session.bus.on("eos.turn_complete", (pkt) => {
      const turn = pkt as { contextId: string; text?: string };
      sendJson(socket, { type: "turn_complete", turnId: turn.contextId, transcript: turn.text ?? "" }, maxBufferedAmountBytes);
    }),
  );
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

  const callbacks: TelephonyOutboundCallbacks = {
    carrierLabel: "browser",
    getContextId: () => currentContextId,
    isActive: () => true, // Always active for metrics and processing, socket state is checked in encodeFrames
    
    encodeFrames: (audio, sourceSampleRateHz, contextId) => {
      const resampled = resampleAudioBytes(audio, sourceSampleRateHz, outputSampleRateHz, streamingResamplers);
      const frames: PacedPlayoutFrame[] = [];
      const frameSampleCount = Math.max(1, Math.round((outputSampleRateHz * outboundFrameDurationMs) / 1000));
      const frameBytesCount = frameSampleCount * 2;

      const pushWireFrame = (
        wireAudio: Uint8Array,
        wireEncoding: "pcm_s16le" | "opus",
        durationMs: number,
      ): void => {
        const sequence = (ttsSequences.get(contextId) ?? 0) + 1;
        ttsSequences.set(contextId, sequence);
        frames.push({
          contextId,
          send: () => {
            if (socket.readyState !== WebSocket.OPEN) return false;
            const jsonSuccess = sendJsonWithResult(socket, {
              type: "tts_chunk",
              turnId: contextId,
              sequence,
              sampleRateHz: outputSampleRateHz,
              encoding: wireEncoding,
              channels: 1,
              byteLength: wireAudio.byteLength,
              durationMs,
            }, maxBufferedAmountBytes);
            if (!jsonSuccess) return false;
            const binaryData = binaryAudioEnvelope
              ? Buffer.from(encodeSyrinxAudioEnvelope({
                  type: "audio",
                  contextId,
                  sequence,
                  sampleRateHz: outputSampleRateHz,
                  encoding: wireEncoding,
                  channels: 1,
                  byteLength: wireAudio.byteLength,
                  durationMs,
                }, wireAudio))
              : Buffer.from(wireAudio);
            return sendSocketDataWithResult(socket, binaryData, maxBufferedAmountBytes);
          },
        });
      };

      if (binaryAudioEnvelope && opusCodec && getBrowserOpusDownlink()) {
        for (let offset = 0; offset < resampled.byteLength; offset += frameBytesCount) {
          const framePcm = resampled.subarray(offset, Math.min(resampled.byteLength, offset + frameBytesCount));
          let samples = pcm16BytesToSamples(framePcm);
          if (outputSampleRateHz !== opusCodec.sampleRateHz) {
            samples = resamplePcm16Streaming(streamingResamplers, samples, outputSampleRateHz, opusCodec.sampleRateHz);
          }
          const flush = offset + frameBytesCount >= resampled.byteLength;
          for (const opus of opusCodec.encodePcm16Frame(samples, flush)) {
            pushWireFrame(opus, "opus", BROWSER_OPUS_FRAME_DURATION_MS);
          }
        }
        return frames;
      }

      for (let offset = 0; offset < resampled.byteLength; offset += frameBytesCount) {
        const frameAudio = resampled.subarray(offset, Math.min(resampled.byteLength, offset + frameBytesCount));
        pushWireFrame(frameAudio, "pcm_s16le", pcm16DurationMs(frameAudio, outputSampleRateHz));
      }
      return frames;
    },

    onInterrupt: (contextId) => {
      ttsSequences.delete(contextId);
      sendJson(socket, { type: "audio_clear", turnId: contextId, reason: "barge_in" }, maxBufferedAmountBytes);
      sendJson(socket, { type: "agent_interrupted", turnId: contextId, reason: "barge_in" }, maxBufferedAmountBytes);
    },

    onDrain: (contextId, playout, progress) => {
      playout.enqueueControl(() => {
        ttsSequences.delete(contextId);
        progress.complete(contextId);
        sendJson(socket, { type: "tts_end", turnId: contextId }, maxBufferedAmountBytes);
      });
    },

    onStop: (reason) => {
      session.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: currentContextId,
        timestampMs: Date.now(),
        name: `browser.${reason}_playout_stopped`,
        value: "1",
      });
    },

    onClear: () => {
      ttsSequences.clear();
    },
  };

  disposers.push(
    session.bus.on("turn.change", (pkt) => {
      currentContextId = (pkt as { contextId: string }).contextId;
    }),
  );

  const turnMetrics = new TurnMetricsTracker(session.bus, (message) => {
    sendJson(socket, message, maxBufferedAmountBytes);
  }, turnMetricsTurns);
  turnMetrics.wire(disposers);

  return wireTelephonyOutboundPipeline({
    session,
    socket,
    disposers,
    outboundFrameDurationMs,
    maxQueuedOutputAudioMs,
    callbacks,
  });
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
  opusCodec: BrowserOpusCodec | null,
  engineInputSampleRateHz: number,
  state: BrowserConnectionState,
  streamingResamplers: Map<string, StreamingPcm16Resampler>,
): string {
  if (isBinary) {
    const binaryAudio = decodeBinaryAudioMessage(
      rawDataToBytes(data),
      inputSampleRateHz,
      rawBinaryInput,
      opusCodec,
      engineInputSampleRateHz,
      streamingResamplers,
    );
    const nextContextId = binaryAudio.contextId ?? currentContextId;
    if (nextContextId !== currentContextId) {
      pushTurnChange(session, nextContextId, currentContextId, "websocket_binary_audio_turn");
    }
    rememberContextSampleRate(contextSampleRates, nextContextId, binaryAudio.sampleRateHz);
    rememberInputSequence(session, inputSequence, nextContextId, binaryAudio.sequence);
    const audio = resampleAudioBytes(binaryAudio.audio, binaryAudio.sampleRateHz, inputSampleRateHz, streamingResamplers);
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
  if (message.type === "codec_capability") {
    state.browserOpusDownlink = message.downlinkEncoding === "opus";
    return currentContextId;
  }
  if (message.type === "client_interrupt") {
    const interruptedContextId = message.assistantContextId ?? message.contextId ?? currentContextId;
    if (interruptedContextId) {
      session.requestClientInterrupt(interruptedContextId);
    }
    return currentContextId;
  }
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
      audio: resampleAudioBytes(decodeStrictBase64(message.audio, "audio"), sourceSampleRateHz, inputSampleRateHz, streamingResamplers),
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
  if (type === "client_interrupt") {
    return {
      type,
      assistantContextId: optionalContextId(value.assistantContextId),
      contextId: optionalContextId(value.contextId),
      reason: optionalString(value.reason, "client_interrupt.reason"),
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
  if (type === "codec_capability") {
    const downlinkEncoding = value.downlinkEncoding;
    if (downlinkEncoding !== "pcm_s16le" && downlinkEncoding !== "opus") {
      throw new Error("codec_capability.downlinkEncoding must be pcm_s16le or opus");
    }
    return { type, downlinkEncoding };
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
  opusCodec: BrowserOpusCodec | null,
  engineInputSampleRateHz: number,
  streamingResamplers: Map<string, StreamingPcm16Resampler>,
): { readonly contextId?: string; readonly sampleRateHz: number; readonly sequence?: number; readonly audio: Uint8Array } {
  if (!hasSyrinxAudioEnvelope(data)) {
    if (!rawBinaryInput) {
      throw new Error(`Raw binary websocket audio is disabled; use ${SYRINX_AUDIO_ENVELOPE_NAME} or JSON audio frames`);
    }
    return { sampleRateHz: defaultSampleRateHz, audio: data };
  }
  const { header, audio } = decodeSyrinxAudioEnvelope(data);
  const sampleRateHz = requirePositiveIntegerFromHeader(header.sampleRateHz) ?? defaultSampleRateHz;
  const wireAudio = header.encoding === "opus"
    ? decodeBrowserOpusIngress(audio, sampleRateHz, opusCodec, engineInputSampleRateHz, streamingResamplers)
    : audio;
  return {
    contextId: typeof header.contextId === "string" && header.contextId.length > 0 ? header.contextId : undefined,
    sampleRateHz,
    sequence: header.sequence,
    audio: wireAudio,
  };
}

function decodeBrowserOpusIngress(
  wire: Uint8Array,
  sampleRateHz: number,
  opusCodec: BrowserOpusCodec | null,
  engineInputSampleRateHz: number,
  streamingResamplers: Map<string, StreamingPcm16Resampler>,
): Uint8Array {
  if (!opusCodec) throw new Error("Browser websocket opus ingress is not initialized");
  if (opusCodec.sampleRateHz !== sampleRateHz) {
    throw new Error(`Browser websocket opus sample rate mismatch: ${sampleRateHz} != ${opusCodec.sampleRateHz}`);
  }
  const pcm = decodeBrowserOpusToPcm16Bytes(wire, opusCodec);
  if (sampleRateHz === engineInputSampleRateHz) return pcm;
  const samples = pcm16BytesToSamples(pcm);
  return pcm16SamplesToBytes(
    resamplePcm16Streaming(streamingResamplers, samples, sampleRateHz, engineInputSampleRateHz),
  );
}

function requirePositiveIntegerFromHeader(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function resampleAudioBytes(
  audio: Uint8Array,
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
  streamingResamplers: Map<string, StreamingPcm16Resampler>,
): Uint8Array {
  if (audio.byteLength % 2 !== 0) {
    throw new Error("PCM16 audio payload must contain an even number of bytes");
  }
  if (sourceSampleRateHz === targetSampleRateHz) return audio;
  const samples = pcm16BytesToSamples(audio);
  const resampled = resamplePcm16Streaming(streamingResamplers, samples, sourceSampleRateHz, targetSampleRateHz);
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

function sendJsonWithResult(socket: WebSocket, value: unknown, maxBufferedAmountBytes: number): boolean {
  return sendSocketDataWithResult(socket, JSON.stringify(value), maxBufferedAmountBytes);
}

function sendSocketData(socket: WebSocket, data: string | Buffer, maxBufferedAmountBytes: number): void {
  sendSocketDataWithResult(socket, data, maxBufferedAmountBytes);
}

function sendSocketDataWithResult(socket: WebSocket, data: string | Buffer, maxBufferedAmountBytes: number): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount + outboundMessageByteLength(data) > maxBufferedAmountBytes) {
    closeWebSocketWithFallback(socket, 1013, "websocket send buffer exceeded");
    return false;
  }
  socket.send(data);
  return true;
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
