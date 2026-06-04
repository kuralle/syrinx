// SPDX-License-Identifier: MIT

import {
  createVoiceEdgeWebSocketUpgrade,
  type VoiceEdgeWebSocketUpgrade,
} from "@asyncdot/voice-server-websocket/edge";
import type { WorkersInboundSocketController } from "@asyncdot/voice-ws/workers";
import { DurableObjectAlarmScheduler } from "./alarm-scheduler.js";
import { DurableObjectSessionStore } from "./durable-session-store.js";
import { createLiveVoiceAgentSession, type LiveSessionEnv } from "./live-session.js";
import { R2EdgeRecorder } from "./r2-recorder.js";

export interface Env extends LiveSessionEnv {
  VOICE_CONVERSATIONS: DurableObjectNamespace;
  /** Optional: when bound, full call audio is recorded to this bucket. */
  RECORDINGS?: R2Bucket;
}

const INPUT_SAMPLE_RATE_HZ = 16000;
const OUTPUT_SAMPLE_RATE_HZ = 16000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/recordings") return await listRecordings(url, env);
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
    const id = env.VOICE_CONVERSATIONS.idFromName(sessionId);
    return await env.VOICE_CONVERSATIONS.get(id).fetch(request);
  },
};

/** List recorded objects for a session: GET /recordings?sessionId=<id>. */
async function listRecordings(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  if (!env.RECORDINGS || !sessionId) return new Response("not found", { status: 404 });
  const listed = await env.RECORDINGS.list({ prefix: `recordings/${sessionId}/` });
  return Response.json(listed.objects.map((o) => ({ key: o.key, size: o.size })));
}

export class VoiceConversation {
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
    const recorder = this.env.RECORDINGS
      ? new R2EdgeRecorder({ bucket: this.env.RECORDINGS, sessionId, startedAtMs: Date.now() })
      : undefined;
    const upgrade = createVoiceEdgeWebSocketUpgrade(request, {
      sessionStore: this.store,
      scheduler: this.scheduler,
      recorder,
      createSession: () =>
        createLiveVoiceAgentSession(this.env, {
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
