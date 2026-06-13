// SPDX-License-Identifier: MIT

import { DurableObject } from "cloudflare:workers";
import { CloudflareDOStorage } from "@mastra/cloudflare/do";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { createTool } from "@mastra/core/tools";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { PipelineBusImpl, Route } from "@kuralle-syrinx/core";
import type { EndOfSpeechPacket } from "@kuralle-syrinx/core";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { fromMastraAgent, type MastraAgentLike } from "@kuralle-syrinx/mastra";
import { DurableObjectRunStore } from "./durable-run-store.js";
import { createSpikeMockModel, resetMockModelCalls } from "./mock-model.js";

export interface Env {
  MASTRA_AGENT: DurableObjectNamespace;
  /** When set, the agent uses a real OpenAI model (gpt-4.1-mini); else a deterministic stub (tests). */
  OPENAI_API_KEY?: string;
}

const DEFAULT_CONTEXT_ID = "mastra-session";

type SqlStorage = DurableObjectState["storage"]["sql"];

function isConfirmed(resumeData: unknown): boolean {
  if (typeof resumeData === "object" && resumeData !== null && "confirmed" in resumeData) {
    return (resumeData as { confirmed?: boolean }).confirmed === true;
  }
  if (typeof resumeData === "string") {
    const normalized = resumeData.trim().toLowerCase();
    return normalized === "yes" || normalized === "confirm" || normalized === "confirmed";
  }
  return false;
}

const confirmTool = createTool({
  id: "confirm-action",
  description: "Confirms an action with the user",
  inputSchema: z.object({ action: z.string() }),
  suspendSchema: z.object({
    action: z.string(),
    reason: z.string().optional(),
  }),
  resumeSchema: z.object({
    confirmed: z.boolean(),
  }),
  execute: async (input: { action: string }, context) => {
    const ctx = context as {
      resumeData?: unknown;
      suspend?: (payload: { action: string; reason?: string }) => Promise<void>;
      agent?: { resumeData?: unknown; suspend?: (payload: { action: string; reason?: string }) => Promise<void> };
      workflow?: { resumeData?: unknown; suspend?: (payload: { action: string; reason?: string }) => Promise<void> };
    } | undefined;
    const resumeData = ctx?.resumeData ?? ctx?.agent?.resumeData ?? ctx?.workflow?.resumeData;
    if (isConfirmed(resumeData)) {
      return { result: `Action "${input.action}" confirmed`, resumed: true };
    }
    const suspend = ctx?.suspend ?? ctx?.agent?.suspend ?? ctx?.workflow?.suspend;
    if (!suspend) throw new Error("suspend not available in tool context");
    return await suspend({ action: input.action, reason: "Needs user confirmation" });
  },
});

function toMastraAgentLike(agent: Agent): MastraAgentLike {
  return {
    stream: (messages, options) =>
      agent.stream(messages as never, {
        abortSignal: options?.abortSignal,
        requireToolApproval: false,
        autoResumeSuspendedTools: false,
      }) as unknown as ReturnType<MastraAgentLike["stream"]>,
    resumeStream: (resumeData, options) =>
      agent.resumeStream(resumeData, {
        runId: options.runId,
        toolCallId: options.toolCallId,
        abortSignal: options.abortSignal,
        requireToolApproval: false,
      }) as unknown as ReturnType<MastraAgentLike["resumeStream"]>,
  };
}

function createMastra(sql: SqlStorage, apiKey?: string): { mastra: Mastra; agent: Agent } {
  const storage = new CloudflareDOStorage({ sql });
  // Real OpenAI model when a key is provided (live deploy); deterministic stub otherwise (tests).
  const model = apiKey
    ? (createOpenAI({ apiKey })("gpt-4.1-mini") as never)
    : (createSpikeMockModel(sql) as never);
  const agent = new Agent({
    id: "support",
    name: "Support Agent",
    instructions:
      "You confirm potentially destructive actions with the user before doing them. " +
      "When asked to deploy, call the confirmAction tool to get confirmation first.",
    model,
    tools: { confirmAction: confirmTool },
  });
  const mastra = new Mastra({
    agents: { support: agent },
    storage,
    logger: false,
  });
  return { mastra, agent };
}

function turnComplete(contextId: string, text: string): EndOfSpeechPacket {
  return {
    kind: "eos.turn_complete",
    contextId,
    timestampMs: Date.now(),
    text,
    transcripts: [],
  };
}

function listMastraTables(sql: SqlStorage): string[] {
  const rows = [...sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )] as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function readPointer(sql: SqlStorage, contextId: string): { runId: string } | null {
  const [row] = [...sql.exec(
    "SELECT run_id FROM reasoning_run_pointers WHERE context_id = ?",
    contextId,
  )] as Array<{ run_id: string }>;
  return row ? { runId: row.run_id } : null;
}

async function driveTurn(
  storage: DurableObjectState["storage"],
  contextId: string,
  userText: string,
  apiKey?: string,
): Promise<{
  packets: Array<{ route: Route; packet: Record<string, unknown> }>;
  pointer: { runId: string } | null;
  mastraTables: string[];
}> {
  const runStore = new DurableObjectRunStore(storage);
  const { agent } = createMastra(storage.sql, apiKey);
  const bridge = new ReasoningBridge(fromMastraAgent(toMastraAgentLike(agent)), {
    runStore,
    onResumeConflict: "restart",
  });
  const packets: Array<{ route: Route; packet: Record<string, unknown> }> = [];
  const bus = new PipelineBusImpl({
    onPacket: (route, packet) => {
      packets.push({ route, packet: packet as unknown as Record<string, unknown> });
    },
  });
  const drain = bus.start();
  await bridge.initialize(bus, { timeout_ms: 30_000, max_history_turns: 12 });
  bus.push(Route.Main, turnComplete(contextId, userText));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const done = packets.some(({ packet }) =>
      packet["kind"] === "llm.done" || packet["kind"] === "reasoning.suspended",
    );
    if (done) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  bus.stop();
  await drain;
  await bridge.close();

  return {
    packets,
    pointer: readPointer(storage.sql, contextId),
    mastraTables: listMastraTables(storage.sql),
  };
}

export class MastraAgentDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const contextId = url.searchParams.get("contextId") ?? DEFAULT_CONTEXT_ID;

    try {
      if (url.pathname === "/health") {
        return new Response("ok");
      }

      if (url.pathname === "/suspend") {
        if (!this.env.OPENAI_API_KEY) resetMockModelCalls(this.ctx.storage.sql, contextId);
        const result = await driveTurn(this.ctx.storage, contextId, "Deploy to production", this.env.OPENAI_API_KEY);
        const suspended = result.packets.find(({ packet }) => packet["kind"] === "reasoning.suspended");
        const llmDone = result.packets.find(({ packet }) => packet["kind"] === "llm.done");
        return Response.json({
          phase: "suspend",
          contextId,
          suspended: suspended !== undefined,
          runId: suspended?.packet["runId"] ?? null,
          prompt: suspended?.packet["prompt"] ?? llmDone?.packet["text"] ?? null,
          pointer: result.pointer,
          mastraTables: result.mastraTables,
          packetKinds: result.packets.map(({ packet }) => packet["kind"]),
        });
      }

      if (url.pathname === "/resume") {
        const body = await request.json() as { userText?: string };
        const userText = body.userText ?? "yes";
        const result = await driveTurn(this.ctx.storage, contextId, userText, this.env.OPENAI_API_KEY);
        const llmDone = result.packets.find(({ packet }) => packet["kind"] === "llm.done");
        const suspended = result.packets.find(({ packet }) => packet["kind"] === "reasoning.suspended");
        return Response.json({
          phase: "resume",
          contextId,
          suspended: suspended !== undefined,
          text: llmDone?.packet["text"] ?? "",
          pointer: result.pointer,
          mastraTables: result.mastraTables,
          packetKinds: result.packets.map(({ packet }) => packet["kind"]),
        });
      }

      return new Response("not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    const id = env.MASTRA_AGENT.idFromName("mastra-session");
    const stub = env.MASTRA_AGENT.get(id);
    return stub.fetch(request);
  },
};
