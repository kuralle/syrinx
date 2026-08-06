// SPDX-License-Identifier: MIT
//
// Telnyx Media Streaming ingress for the Workers edge: bridges Telnyx's WebSocket
// protocol (base64 RTP-in-JSON, PCMU/PCMA/G722/L16) to a VoiceAgentSession, mirroring
// the session-lease/heartbeat pattern of edge-twilio.ts. Provider-agnostic — the bridge
// only speaks core packets (user.audio_received / tts.audio / interrupt.detected).
//
// Codec transcoding is shared with the Node host via telnyx-codec.ts (Workers-safe).
// Live trunk negotiation (streaming_start → /telnyx) is carrier-gated / unit-tested only.
//
// Barge-in: interrupt.detected → Telnyx `clear` event. Playout-clock caveat: like the
// browser/Twilio edge paths, turn-taking uses the estimate fallback (no paced transport
// progress events on the edge yet).

import {
  Route,
  TimerScheduler,
  type Scheduler,
  type VoiceAgentSession,
  type TextToSpeechAudioPacket,
} from "@kuralle-syrinx/core";
import {
  pcm16BytesToSamples,
  pcm16SamplesToBytes,
  resamplePcm16Streaming,
  type StreamingPcm16Resampler,
} from "@kuralle-syrinx/core/audio";
import type { ManagedSocket, SocketData } from "@kuralle-syrinx/ws";
import {
  BackgroundAudioMixer,
  wireBackgroundAudio,
  type BackgroundAudioConfig,
} from "./background-audio.js";
import {
  createWorkersInboundSocket,
  type WorkersDurableObjectWebSocketContext,
} from "@kuralle-syrinx/ws/workers";
import type { SessionStore, ManagedSession } from "./session-store.js";
import {
  createTelnyxG722State,
  decodeTelnyxInboundPayload,
  defaultTelnyxContextId,
  encodeTelnyxOutboundPayload,
  validateTelnyxStart,
  wireSampleRateForCodec,
  type TelnyxCodec,
  type TelnyxG722State,
  type TelnyxStartPayload,
} from "./telnyx-codec.js";

const DEFAULT_RESUME_WINDOW_MS = 15_000;
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const KEEP_ALIVE_KEY = "voice.edge.telnyx.keep_alive";

export interface TelnyxEdgeWebSocketOptions {
  readonly sessionStore: SessionStore;
  readonly createSession: (request: Request) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly scheduler?: Scheduler;
  /** Engine-side PCM rate (default 16000). Wire rate follows the negotiated codec. */
  readonly engineSampleRateHz?: number;
  /**
   * Default bidirectional codec when `start.media_format` is absent (should match the
   * `stream_bidirectional_codec` used when starting the Telnyx stream). @default "PCMU"
   */
  readonly bidirectionalCodec?: TelnyxCodec;
  /**
   * Ambient/thinking bed: mixed (ducked) under assistant speech, and sent as
   * comfort-noise frames between turns — pure digital silence on a phone line
   * reads as "the call died". Thinking loop follows the G3 tool-call cues.
   */
  readonly backgroundAudio?: BackgroundAudioConfig;
  /** Cadence of idle comfort-noise frames (ms). @default 200 */
  readonly backgroundIdleFrameMs?: number;
  readonly resumeWindowMs?: number;
  readonly keepAliveIntervalMs?: number;
  readonly idleTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

export interface TelnyxEdgeWebSocketUpgrade {
  readonly response: Response;
  readonly controller: ReturnType<typeof createWorkersInboundSocket>["controller"];
}

export function createTelnyxEdgeWebSocketUpgrade(
  request: Request,
  options: TelnyxEdgeWebSocketOptions,
  ctx?: WorkersDurableObjectWebSocketContext,
): TelnyxEdgeWebSocketUpgrade {
  const inbound = createWorkersInboundSocket(ctx);
  void runTelnyxEdgeWebSocketConnection(inbound.socket, request, options);
  return { response: inbound.response, controller: inbound.controller };
}

export async function runTelnyxEdgeWebSocketConnection(
  socket: ManagedSocket,
  request: Request,
  options: TelnyxEdgeWebSocketOptions,
): Promise<void> {
  const scheduler = options.scheduler ?? new TimerScheduler();
  const engineRate = options.engineSampleRateHz ?? 16_000;
  const defaultCodec: TelnyxCodec = options.bidirectionalCodec ?? "PCMU";
  const resumeWindowMs = options.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;
  const keepAliveIntervalMs = options.keepAliveIntervalMs ?? DEFAULT_KEEP_ALIVE_INTERVAL_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  const uplinkResamplers = new Map<string, StreamingPcm16Resampler>();
  const downlinkResamplers = new Map<string, StreamingPcm16Resampler>();
  const disposers: Array<() => void> = [];
  let session: VoiceAgentSession | null = null;
  let managed: ManagedSession | null = null;
  let pendingLease: Promise<{ managed: ManagedSession }> | null = null;
  let sessionId = "";
  let streamId = "";
  let contextId = "";
  let contextBase = "";
  let turnCounter = 0;
  let closed = false;
  let stopped = false;
  let lastClientMessageMs = Date.now();
  let wireCodec: TelnyxCodec = defaultCodec;
  let wireSampleRateHz = wireSampleRateForCodec(defaultCodec);
  let g722: TelnyxG722State = createTelnyxG722State(defaultCodec);
  let started = false;

  const sendTelnyxJson = (value: unknown): void => {
    if (!socket.isOpen) return;
    socket.send(JSON.stringify(value));
  };

  const encodeWirePayload = (samplesAtWireRate: Int16Array): Uint8Array =>
    encodeTelnyxOutboundPayload(samplesAtWireRate, wireCodec, g722);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    scheduler.cancel(KEEP_ALIVE_KEY);
    scheduler.cancel("voice.edge.telnyx.startup");
    for (const dispose of disposers.splice(0)) dispose();
    if (managed && sessionId) {
      // Decrement the connection count BEFORE releasing (R1) — otherwise release
      // early-returns while connectionCount > 0 and session.close() never runs, so
      // Deepgram/TTS provider sockets + the reasoner leak until DO eviction. A
      // caller-hangup (`stopped`) releases immediately (retain 0); a transient drop
      // keeps the session warm for the resume window.
      managed.connectionCount = Math.max(0, managed.connectionCount - 1);
      void options.sessionStore.release(sessionId, stopped ? 0 : resumeWindowMs);
    } else if (pendingLease && sessionId) {
      // Closed before the lease was adopted (e.g. startup-timeout race): tear the
      // in-flight session down when it resolves so it is never orphaned in the store.
      const id = sessionId;
      void pendingLease
        .then((leased) => {
          leased.managed.connectionCount = Math.max(0, leased.managed.connectionCount - 1);
          return options.sessionStore.release(id, 0);
        })
        .catch(() => undefined);
    }
  };

  socket.onClose(() => {
    cleanup();
  });
  socket.onError(() => {
    cleanup();
  });

  // Telnyx sends connected/start (and media) immediately after the upgrade —
  // before the session lease (provider sockets, kuralle init) resolves. Buffer
  // until the handler is live or the start event is lost and the whole call
  // streams into the void.
  const pendingMessages: Array<{ data: SocketData; isBinary: boolean }> = [];
  let pendingBytes = 0;
  let liveHandler: ((data: SocketData, isBinary: boolean) => void) | null = null;
  socket.onMessage((data: SocketData, isBinary: boolean) => {
    lastClientMessageMs = Date.now();
    if (liveHandler) {
      liveHandler(data, isBinary);
      return;
    }
    const byteLength = typeof data === "string" ? data.length : (data as ArrayBuffer | Uint8Array).byteLength;
    if (pendingBytes + byteLength > 2 * 1024 * 1024) return; // cap startup buffering
    pendingBytes += byteLength;
    pendingMessages.push({ data, isBinary });
  });

  try {
    const url = new URL(request.url);
    sessionId = url.searchParams.get("sessionId")?.trim() || crypto.randomUUID();

    const startupTimer = new Promise<never>((_, reject) => {
      scheduler.schedule("voice.edge.telnyx.startup", startupTimeoutMs, () => {
        reject(new Error("telnyx session startup timeout"));
      });
    });
    pendingLease = options.sessionStore.lease(sessionId, async () => {
      const sess = await options.createSession(request);
      await sess.start();
      return {
        id: sessionId,
        session: sess,
        currentContextId: "",
        contextSampleRates: new Map(),
        inputSequence: { lastSequence: null },
        turnMetricsTurns: new Map(),
        closeTimer: null,
        connectionCount: 1,
      };
    });
    const leased = await Promise.race([pendingLease, startupTimer]);
    pendingLease = null;
    scheduler.cancel("voice.edge.telnyx.startup");
    managed = leased.managed;
    session = managed.session;
    if (closed) {
      // The socket closed while the session was starting up — tear the just-started
      // session down instead of orphaning it (decrement so release actually closes it).
      managed.connectionCount = Math.max(0, managed.connectionCount - 1);
      await options.sessionStore.release(sessionId, 0);
      return;
    }

    // Background bed: ducked under speech in the tts.audio handler below, and
    // sent as idle comfort-noise frames between turns — a phone line carrying
    // pure digital silence reads as "the call died". Telnyx's `clear` on
    // barge-in drops any queued bed audio; the ticker refills on the next tick.
    const backgroundAudio = options.backgroundAudio
      ? new BackgroundAudioMixer(options.backgroundAudio)
      : null;
    if (backgroundAudio) {
      wireBackgroundAudio(session, backgroundAudio);
      const idleFrameMs = options.backgroundIdleFrameMs ?? 200;
      const idleTimer = setInterval(() => {
        if (!streamId || !started || stopped || closed || !socket.isOpen) return;
        const frame = backgroundAudio.idleFrame(idleFrameMs, wireSampleRateHz);
        if (!frame) return;
        const samples = pcm16BytesToSamples(frame);
        const payload = encodeWirePayload(samples);
        sendTelnyxJson({ event: "media", media: { payload: bytesToBase64(payload) } });
      }, idleFrameMs);
      disposers.push(() => clearInterval(idleTimer));
    }

    // Downlink: engine PCM → wire codec media frames; barge-in → clear.
    disposers.push(
      session.bus.on("tts.audio", (pkt) => {
        if (!streamId || !started) return;
        const audio = pkt as TextToSpeechAudioPacket;
        const sourceRate = audio.sampleRateHz ?? engineRate;
        const wireAudio = backgroundAudio ? backgroundAudio.mix(audio.audio, sourceRate) : audio.audio;
        const samples = pcm16BytesToSamples(wireAudio);
        const resampled = resamplePcm16Streaming(downlinkResamplers, samples, sourceRate, wireSampleRateHz);
        const payload = encodeWirePayload(resampled);
        sendTelnyxJson({
          event: "media",
          media: { payload: bytesToBase64(payload) },
        });
      }),
      session.bus.on("interrupt.detected", () => {
        if (!streamId || !started) return;
        sendTelnyxJson({ event: "clear" });
      }),
      // The phone mic streams continuously on one call, but the engine finishes a
      // turn per contextId — rotate on turn_complete exactly like the browser
      // client does, or only the first utterance is ever heard (the STT plugin
      // drops transcripts for already-finalized contexts).
      session.bus.on("eos.turn_complete", () => {
        if (!contextBase) return;
        turnCounter += 1;
        contextId = `${contextBase}-t${String(turnCounter)}`;
      }),
    );

    if (keepAliveIntervalMs > 0) {
      const heartbeat = (): void => {
        if (closed) return;
        if (idleTimeoutMs > 0 && Date.now() - lastClientMessageMs > idleTimeoutMs) {
          socket.dispose();
          return;
        }
        scheduler.schedule(KEEP_ALIVE_KEY, keepAliveIntervalMs, heartbeat);
      };
      scheduler.schedule(KEEP_ALIVE_KEY, keepAliveIntervalMs, heartbeat);
    }

    const handleMessage = (data: SocketData, isBinary: boolean): void => {
      if (isBinary || closed || !session) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(socketDataToText(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const event = message["event"];
      if (event === "connected" || event === "mark" || event === "dtmf") return;
      if (event === "start") {
        const start = (message["start"] ?? {}) as TelnyxStartPayload;
        streamId =
          (typeof message["stream_id"] === "string" && message["stream_id"]) ||
          (typeof start.stream_id === "string" && start.stream_id) ||
          "";
        try {
          if (start.media_format) {
            const format = validateTelnyxStart(start);
            wireCodec = format.codec;
            wireSampleRateHz = format.sampleRateHz;
            g722 = createTelnyxG722State(wireCodec);
          } else {
            wireCodec = defaultCodec;
            wireSampleRateHz = wireSampleRateForCodec(defaultCodec);
            g722 = createTelnyxG722State(defaultCodec);
          }
        } catch {
          // Malformed start: keep defaults so the call can still proceed with
          // the configured bidirectional codec (unit path); live trunks always
          // send media_format.
        }
        contextBase = defaultTelnyxContextId({
          ...start,
          stream_id: streamId || start.stream_id,
        });
        contextId = contextBase;
        started = true;
        return;
      }
      if (event === "media") {
        const media = (message["media"] ?? {}) as Record<string, unknown>;
        const payload = typeof media["payload"] === "string" ? media["payload"] : "";
        if (!payload || !contextId || !started) return;
        const encoded = base64ToBytes(payload);
        const pcmWire = decodeTelnyxInboundPayload(encoded, wireCodec, g722);
        const pcmEngine = resamplePcm16Streaming(uplinkResamplers, pcmWire, wireSampleRateHz, engineRate);
        session.bus.push(Route.Media, {
          kind: "user.audio_received",
          contextId,
          timestampMs: Date.now(),
          audio: pcm16SamplesToBytes(pcmEngine),
          sampleRateHz: engineRate,
        });
        return;
      }
      if (event === "stop") {
        stopped = true;
        started = false;
        socket.dispose();
      }
    };
    liveHandler = handleMessage;
    for (const queued of pendingMessages.splice(0)) {
      handleMessage(queued.data, queued.isBinary);
    }
  } catch (err) {
    sendTelnyxJson({
      event: "error",
      payload: {
        code: 100003,
        title: "syrinx_transport_error",
        detail: err instanceof Error ? err.message : String(err),
      },
    });
    socket.dispose();
    cleanup();
  }
}

function socketDataToText(data: SocketData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return new TextDecoder().decode(data as Uint8Array);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
