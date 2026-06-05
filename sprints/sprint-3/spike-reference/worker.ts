// SPDX-License-Identifier: MIT

import { DurableObject } from "cloudflare:workers";
import { CloudflareDOStorage } from "@mastra/cloudflare/do";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createSpikeMockModel } from "./mock-model.js";

export interface Env {
  MASTRA_AGENT: DurableObjectNamespace;
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
  execute: async (input: { action: string }, context?: {
    resumeData?: { confirmed?: boolean };
    suspend?: (payload: unknown) => Promise<void>;
    agent?: { resumeData?: { confirmed?: boolean }; suspend?: (payload: unknown) => Promise<void> };
    workflow?: { resumeData?: { confirmed?: boolean }; suspend?: (payload: unknown) => Promise<void> };
  }) => {
    const resumeData = context?.resumeData ?? context?.agent?.resumeData ?? context?.workflow?.resumeData;
    if (resumeData?.confirmed) {
      return { result: `Action "${input.action}" confirmed`, resumed: true };
    }
    const suspend = context?.suspend ?? context?.agent?.suspend ?? context?.workflow?.suspend;
    if (!suspend) throw new Error("suspend not available in tool context");
    return await suspend({ action: input.action, reason: "Needs user confirmation" });
  },
});

function createMastra(sql: SqlStorage): Mastra {
  const storage = new CloudflareDOStorage({ sql });
  const agent = new Agent({
    id: "spike-agent",
    name: "Spike Agent",
    instructions: "You confirm actions before deploying.",
    model: createSpikeMockModel(sql) as never,
    tools: { confirmAction: confirmTool },
  });
  return new Mastra({
    agents: { "spike-agent": agent },
    storage,
    logger: false,
  });
}

type SqlStorage = DurableObjectState["storage"]["sql"];

async function drainStream(
  stream: AsyncIterable<{ type: string; payload?: Record<string, unknown> }>,
): Promise<{
  runId?: string;
  suspended: boolean;
  suspendPayload?: unknown;
  text: string;
  chunkTypes: string[];
  error?: string;
}> {
  const chunkTypes: string[] = [];
  let runId: string | undefined;
  let suspended = false;
  let suspendPayload: unknown;
  let text = "";
  let error: string | undefined;
  let toolError: string | undefined;

  for await (const chunk of stream) {
    chunkTypes.push(chunk.type);
    if (chunk.type === "text-delta") {
      text += String(chunk.payload?.text ?? chunk.payload?.delta ?? "");
    }
    if (chunk.type === "tool-call-suspended") {
      suspended = true;
      suspendPayload = chunk.payload?.suspendPayload ?? chunk.payload;
      const payloadRunId = chunk.payload?.runId;
      if (typeof payloadRunId === "string" && payloadRunId.length > 0) {
        runId = payloadRunId;
      }
    }
    if (chunk.type === "start" && typeof chunk.payload?.runId === "string") {
      runId = chunk.payload.runId;
    }
    if (chunk.type === "tool-error") {
      toolError = JSON.stringify(chunk.payload ?? {});
    }
    if (chunk.type === "error") {
      error = String(chunk.payload?.error ?? "unknown stream error");
    }
  }

  return { runId, suspended, suspendPayload, text, chunkTypes, error, toolError };
}

export class MastraAgentDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const mastra = createMastra(this.ctx.storage.sql);
    const agent = mastra.getAgent("spike-agent");

    try {
      if (url.pathname === "/suspend") {
        this.ctx.storage.sql.exec("DELETE FROM spike_mock_calls WHERE key = ?", "spike-session");
        const out = await agent.stream("Deploy to production", {
          requireToolApproval: false,
          autoResumeSuspendedTools: false,
        });
        const result = await drainStream(out.fullStream);
        const runId = String((out as { runId?: string }).runId ?? result.runId ?? "");
        return Response.json({
          phase: "suspend",
          ...result,
          runId,
        });
      }

      if (url.pathname === "/resume") {
        const body = await request.json() as { runId: string; data?: Record<string, unknown> };
        const out = await agent.resumeStream(body.data ?? { confirmed: true }, {
          runId: body.runId,
          requireToolApproval: false,
        });
        const result = await drainStream(out.fullStream);
        return Response.json({
          phase: "resume",
          runId: out.runId,
          ...result,
        });
      }

      if (url.pathname === "/health") {
        return new Response("ok");
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
    const id = env.MASTRA_AGENT.idFromName("spike-session");
    const stub = env.MASTRA_AGENT.get(id);
    return stub.fetch(request);
  },
};
