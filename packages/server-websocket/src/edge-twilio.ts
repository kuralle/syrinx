// SPDX-License-Identifier: MIT
//
// Twilio Media Streams ingress for the Workers edge: bridges Twilio's WebSocket
// protocol (base64 μ-law 8 kHz both ways) to a VoiceAgentSession, mirroring the
// session-lease/heartbeat pattern of edge.ts. Provider-agnostic — the bridge only
// speaks core packets (user.audio_received / tts.audio / interrupt.detected).
//
// Barge-in: interrupt.detected → Twilio `clear` event, which drops Twilio's
// buffered playout instantly (their barge-in mechanism). Playout-clock caveat:
// like the browser edge path, turn-taking uses the estimate fallback (no paced
// transport progress events on the edge yet).

import {
  Route,
  TimerScheduler,
  type Scheduler,
  type VoiceAgentSession,
  type TextToSpeechAudioPacket,
} from "@kuralle-syrinx/core";
import {
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
  pcm16BytesToSamples,
  pcm16SamplesToBytes,
  resamplePcm16Streaming,
  type StreamingPcm16Resampler,
} from "@kuralle-syrinx/core/audio";
import type { ManagedSocket, SocketData } from "@kuralle-syrinx/ws";
import {
  createWorkersInboundSocket,
  type WorkersDurableObjectWebSocketContext,
} from "@kuralle-syrinx/ws/workers";
import type { SessionStore, ManagedSession } from "./session-store.js";

const TWILIO_SAMPLE_RATE_HZ = 8_000;
const DEFAULT_RESUME_WINDOW_MS = 15_000;
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const KEEP_ALIVE_KEY = "voice.edge.twilio.keep_alive";

export interface TwilioEdgeWebSocketOptions {
  readonly sessionStore: SessionStore;
  readonly createSession: (request: Request) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly scheduler?: Scheduler;
  /** Engine-side PCM rate (default 16000). Twilio's leg is always 8 kHz μ-law. */
  readonly engineSampleRateHz?: number;
  readonly resumeWindowMs?: number;
  readonly keepAliveIntervalMs?: number;
  readonly idleTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

export interface TwilioEdgeWebSocketUpgrade {
  readonly response: Response;
  readonly controller: ReturnType<typeof createWorkersInboundSocket>["controller"];
}

export function createTwilioEdgeWebSocketUpgrade(
  request: Request,
  options: TwilioEdgeWebSocketOptions,
  ctx?: WorkersDurableObjectWebSocketContext,
): TwilioEdgeWebSocketUpgrade {
  const inbound = createWorkersInboundSocket(ctx);
  void runTwilioEdgeWebSocketConnection(inbound.socket, request, options);
  return { response: inbound.response, controller: inbound.controller };
}

export async function runTwilioEdgeWebSocketConnection(
  socket: ManagedSocket,
  request: Request,
  options: TwilioEdgeWebSocketOptions,
): Promise<void> {
  const scheduler = options.scheduler ?? new TimerScheduler();
  const engineRate = options.engineSampleRateHz ?? 16_000;
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
  let streamSid = "";
  let contextId = "";
  let contextBase = "";
  let turnCounter = 0;
  let closed = false;
  let stopped = false;
  let lastClientMessageMs = Date.now();

  const sendTwilioJson = (value: unknown): void => {
    if (!socket.isOpen) return;
    socket.send(JSON.stringify(value));
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    scheduler.cancel(KEEP_ALIVE_KEY);
    scheduler.cancel("voice.edge.twilio.startup");
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

  // Twilio sends connected/start (and media) immediately after the upgrade —
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
      scheduler.schedule("voice.edge.twilio.startup", startupTimeoutMs, () => {
        reject(new Error("twilio session startup timeout"));
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
    scheduler.cancel("voice.edge.twilio.startup");
    managed = leased.managed;
    session = managed.session;
    if (closed) {
      // The socket closed while the session was starting up — tear the just-started
      // session down instead of orphaning it (decrement so release actually closes it).
      managed.connectionCount = Math.max(0, managed.connectionCount - 1);
      await options.sessionStore.release(sessionId, 0);
      return;
    }

    // Downlink: engine PCM → 8 kHz μ-law media frames; barge-in → clear.
    disposers.push(
      session.bus.on("tts.audio", (pkt) => {
        if (!streamSid) return;
        const audio = pkt as TextToSpeechAudioPacket;
        const samples = pcm16BytesToSamples(audio.audio);
        const sourceRate = audio.sampleRateHz ?? engineRate;
        const resampled = resamplePcm16Streaming(downlinkResamplers, samples, sourceRate, TWILIO_SAMPLE_RATE_HZ);
        const mulaw = encodePcm16ToMuLaw(resampled);
        sendTwilioJson({
          event: "media",
          streamSid,
          media: { payload: bytesToBase64(mulaw) },
        });
      }),
      session.bus.on("interrupt.detected", () => {
        if (!streamSid) return;
        sendTwilioJson({ event: "clear", streamSid });
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
        const start = (message["start"] ?? {}) as Record<string, unknown>;
        streamSid =
          (typeof start["streamSid"] === "string" && start["streamSid"]) ||
          (typeof message["streamSid"] === "string" && message["streamSid"]) ||
          "";
        const callSid = typeof start["callSid"] === "string" ? start["callSid"] : "";
        contextBase = callSid ? `twilio-${callSid}` : `twilio-${streamSid || sessionId}`;
        contextId = contextBase;
        return;
      }
      if (event === "media") {
        const media = (message["media"] ?? {}) as Record<string, unknown>;
        const payload = typeof media["payload"] === "string" ? media["payload"] : "";
        if (!payload || !contextId) return;
        const mulaw = base64ToBytes(payload);
        const pcm8k = decodeMuLawToPcm16(mulaw);
        const pcm16k = resamplePcm16Streaming(uplinkResamplers, pcm8k, TWILIO_SAMPLE_RATE_HZ, engineRate);
        session.bus.push(Route.Main, {
          kind: "user.audio_received",
          contextId,
          timestampMs: Date.now(),
          audio: pcm16SamplesToBytes(pcm16k),
        });
        return;
      }
      if (event === "stop") {
        stopped = true;
        socket.dispose();
      }
    };
    liveHandler = handleMessage;
    for (const queued of pendingMessages.splice(0)) {
      handleMessage(queued.data, queued.isBinary);
    }
  } catch (err) {
    sendTwilioJson({
      event: "error",
      message: err instanceof Error ? err.message : String(err),
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
