// SPDX-License-Identifier: MIT

import {
  createVoiceEdgeWebSocketUpgrade,
  type VoiceEdgeWebSocketUpgrade,
} from "@asyncdot/voice-server-websocket/edge";
import type { WorkersInboundSocketController } from "@asyncdot/voice-ws/workers";
import { DurableObjectAlarmScheduler } from "./alarm-scheduler.js";
import { DurableObjectSessionStore } from "./durable-session-store.js";
import { StubVoiceAgentSession } from "./stub-session.js";

export interface Env {
  VOICE_CONVERSATIONS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
    const id = env.VOICE_CONVERSATIONS.idFromName(sessionId);
    return await env.VOICE_CONVERSATIONS.get(id).fetch(request);
  },
};

export class VoiceConversation {
  private readonly scheduler: DurableObjectAlarmScheduler;
  private readonly store: DurableObjectSessionStore;
  private activeUpgrade: VoiceEdgeWebSocketUpgrade | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {
    this.scheduler = new DurableObjectAlarmScheduler(ctx.storage);
    this.store = new DurableObjectSessionStore(ctx.storage, this.scheduler);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const upgrade = createVoiceEdgeWebSocketUpgrade(request, {
      sessionStore: this.store,
      scheduler: this.scheduler,
      createSession: () => new StubVoiceAgentSession().asVoiceAgentSession(),
      sessionId: (req) => new URL(req.url).searchParams.get("sessionId") ?? crypto.randomUUID(),
      inputSampleRateHz: 16000,
      outputSampleRateHz: 16000,
      resumeWindowMs: 15_000,
    }, {
      acceptWebSocket: (socket) => this.ctx.acceptWebSocket(socket as WebSocket),
    });
    this.activeUpgrade = upgrade;
    return upgrade.response;
  }

  async alarm(): Promise<void> {
    await this.scheduler.runDue();
  }

  webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
    this.controller?.message(message);
  }

  webSocketClose(_ws: WebSocket, code: number, reason: string): void {
    this.controller?.close(code, reason);
    this.activeUpgrade = null;
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    this.controller?.error(error instanceof Error ? error : new Error(String(error)));
  }

  private get controller(): WorkersInboundSocketController | undefined {
    return this.activeUpgrade?.controller;
  }
}
