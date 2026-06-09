// SPDX-License-Identifier: MIT

import {
  createVoiceEdgeWebSocketUpgrade,
  type VoiceEdgeWebSocketUpgrade,
} from "@kuralle-syrinx/server-websocket/edge";
import type { WorkersInboundSocketController } from "@kuralle-syrinx/ws/workers";
import { DurableObjectAlarmScheduler } from "./alarm-scheduler.js";
import { DurableObjectSessionStore } from "./durable-session-store.js";
import {
  createRealtimeVoiceAgentSession,
  type RealtimeSessionEnv,
} from "./live-realtime-session.js";

export interface Env extends RealtimeSessionEnv {
  readonly REALTIME_VOICE_CONVERSATIONS: DurableObjectNamespace;
}

const INPUT_SAMPLE_RATE_HZ = 16000;
const OUTPUT_SAMPLE_RATE_HZ = 16000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
    const id = env.REALTIME_VOICE_CONVERSATIONS.idFromName(sessionId);
    return await env.REALTIME_VOICE_CONVERSATIONS.get(id).fetch(request);
  },
};

export class RealtimeVoiceConversation {
  private readonly scheduler: DurableObjectAlarmScheduler;
  private readonly store: DurableObjectSessionStore;
  private activeUpgrade: VoiceEdgeWebSocketUpgrade | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.scheduler = new DurableObjectAlarmScheduler(ctx.storage);
    this.store = new DurableObjectSessionStore(ctx.storage, this.scheduler);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const sessionId = new URL(request.url).searchParams.get("sessionId") ?? crypto.randomUUID();
    const upgrade = createVoiceEdgeWebSocketUpgrade(request, {
      sessionStore: this.store,
      scheduler: this.scheduler,
      createSession: () =>
        createRealtimeVoiceAgentSession(this.env, {
          sessionId,
          inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
          outputSampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
        }),
      sessionId: () => sessionId,
      inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      outputSampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
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
