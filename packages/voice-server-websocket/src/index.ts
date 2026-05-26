// SPDX-License-Identifier: MIT

import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  Route,
  type TextToSpeechAudioPacket,
  type UserAudioReceivedPacket,
  type UserTextReceivedPacket,
  type VoiceAgentSession,
} from "@asyncdot/voice";

export interface VoiceWebSocketServerOptions {
  readonly server?: HttpServer;
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  readonly createSession: (request: IncomingMessage) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly contextId?: () => string;
}

export interface VoiceWebSocketServer {
  readonly httpServer: HttpServer;
  readonly wsServer: WebSocketServer;
  address(): ReturnType<HttpServer["address"]>;
  close(): Promise<void>;
}

type ClientMessage =
  | { readonly type: "text"; readonly text: string; readonly contextId?: string }
  | { readonly type: "audio"; readonly audio: string; readonly contextId?: string }
  | { readonly type: "ping" };

export async function createVoiceWebSocketServer(
  options: VoiceWebSocketServerOptions,
): Promise<VoiceWebSocketServer> {
  const ownsHttpServer = !options.server;
  const httpServer = options.server ?? createServer();
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: options.path ?? "/ws",
  });
  const sessions = new Set<VoiceAgentSession>();
  const contextId = options.contextId ?? defaultContextId;

  wsServer.on("connection", (socket, request) => {
    void handleConnection({
      socket,
      request,
      createSession: options.createSession,
      contextId,
      sessions,
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
      if (ownsHttpServer || typeof options.port === "number") {
        await new Promise<void>((resolveClose) => {
          httpServer.close(() => resolveClose());
        });
      }
    },
  };
}

async function handleConnection(args: {
  readonly socket: WebSocket;
  readonly request: IncomingMessage;
  readonly createSession: (request: IncomingMessage) => VoiceAgentSession | Promise<VoiceAgentSession>;
  readonly contextId: () => string;
  readonly sessions: Set<VoiceAgentSession>;
}): Promise<void> {
  const { socket, request, createSession, contextId, sessions } = args;
  let session: VoiceAgentSession | null = null;
  let currentContextId = contextId();
  const disposers: Array<() => void> = [];

  try {
    session = await createSession(request);
    sessions.add(session);
    wireSessionEvents(session, socket, disposers);
    await session.start();
    sendJson(socket, { type: "ready", sessionId: currentContextId });
  } catch (err) {
    sendJson(socket, {
      type: "error",
      component: "session",
      category: "initialization",
      message: err instanceof Error ? err.message : String(err),
    });
    socket.close(1011, "session initialization failed");
    return;
  }

  socket.on("message", (data, isBinary) => {
    if (!session) return;
    try {
      currentContextId = handleClientMessage(session, data, isBinary, currentContextId, contextId);
    } catch (err) {
      sendJson(socket, {
        type: "error",
        component: "transport",
        category: "invalid_input",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  socket.on("close", () => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    if (session) {
      sessions.delete(session);
      void session.close().catch(() => undefined);
    }
  });
}

function wireSessionEvents(
  session: VoiceAgentSession,
  socket: WebSocket,
  disposers: Array<() => void>,
): void {
  session.on("user_input_partial", (event) => {
    sendJson(socket, { type: "stt_chunk", transcript: event.text });
  });
  session.on("user_input_final", (event) => {
    sendJson(socket, { type: "stt_output", transcript: event.text, confidence: event.confidence });
  });
  session.on("agent_text_delta", (event) => {
    sendJson(socket, { type: "agent_chunk", text: event.delta });
  });
  session.on("agent_finished", (event) => {
    sendJson(socket, { type: "agent_end", turnId: event.turnId });
  });
  session.on("error", (event) => {
    sendJson(socket, {
      type: "error",
      component: event.stage,
      category: event.category,
      message: event.message,
    });
  });

  disposers.push(
    session.bus.on("tts.audio", (pkt) => {
      const audio = (pkt as TextToSpeechAudioPacket).audio;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(Buffer.from(audio));
      }
    }),
  );
}

function handleClientMessage(
  session: VoiceAgentSession,
  data: RawData,
  isBinary: boolean,
  currentContextId: string,
  contextId: () => string,
): string {
  if (isBinary) {
    const audio = rawDataToBytes(data);
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: currentContextId,
      timestampMs: Date.now(),
      audio,
    } satisfies UserAudioReceivedPacket);
    return currentContextId;
  }

  const text = rawDataToText(data);
  const message = JSON.parse(text) as ClientMessage;
  if (message.type === "ping") return currentContextId;
  if (message.type === "text") {
    const nextContextId = message.contextId ?? contextId();
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
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: nextContextId,
      timestampMs: Date.now(),
      audio: Uint8Array.from(Buffer.from(message.audio, "base64")),
    } satisfies UserAudioReceivedPacket);
    return nextContextId;
  }
  throw new Error("Unsupported client message type");
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data));
  throw new Error("Unsupported binary message payload");
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  throw new Error("Unsupported text message payload");
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(value));
}

function defaultContextId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
