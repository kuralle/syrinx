import { createOpenAI } from "@ai-sdk/openai";
import { CloudflareVectorizeStore, type VectorizeBinding } from "@kuralle-agents/vectorize-store";
import { AiSdkEmbedder } from "@kuralle-agents/rag";
import type { VectorizeIndex } from "@cloudflare/workers-types";
import { createFullUniversityRuntime } from "./agent";

interface Env {
  readonly OPENAI_API_KEY: string;
  readonly VECTORIZE: VectorizeIndex;
  readonly EDGE_TOKEN: string;
}

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

function requireEdgeToken(request: Request, env: Env): Response | null {
  const token = request.headers.get("x-edge-token");
  if (!env.EDGE_TOKEN || token !== env.EDGE_TOKEN) return unauthorized();
  return null;
}

interface StreamPart {
  readonly type: string;
  readonly delta?: string;
}

let rtPromise: ReturnType<typeof createFullUniversityRuntime> | undefined;

function getStore(env: Env) {
  return new CloudflareVectorizeStore({ binding: env.VECTORIZE as unknown as VectorizeBinding });
}

function getRt(env: Env) {
  return (rtPromise ??= createFullUniversityRuntime({
    apiKey: env.OPENAI_API_KEY,
    vectorStore: getStore(env),
  }));
}

function sseLine(data: string): string {
  return `data: ${data}\n\n`;
}

function sseEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ingest" && request.method === "POST") {
      const authFailure = requireEdgeToken(request, env);
      if (authFailure) return authFailure;

      const start = performance.now();
      const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
      const embedder = new AiSdkEmbedder({ model: openai.embedding("text-embedding-3-small") });
      const store = getStore(env);
      const { ingestCorpus } = await import("./agent");
      const result = await ingestCorpus(store, embedder);
      const describe = await env.VECTORIZE.describe();
      const ms = Math.round(performance.now() - start);
      const vectorCount =
        "vectorCount" in describe
          ? (describe as { vectorCount: number }).vectorCount
          : (describe as { vectorsCount: number }).vectorsCount;
      return Response.json({
        ingested: result.count,
        ids: result.ids,
        ms,
        vectorCount,
      });
    }

    if (url.pathname === "/chat" && request.method === "GET") {
      const authFailure = requireEdgeToken(request, env);
      if (authFailure) return authFailure;

      const q = url.searchParams.get("q");
      if (!q) {
        return new Response("missing q", { status: 400 });
      }

      const sessionId = url.searchParams.get("session") ?? crypto.randomUUID();
      const cold = rtPromise === undefined;

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));

          try {
            const runtime = await getRt(env);
            const runStart = performance.now();
            const handle = runtime.run({ input: q, sessionId, userId: "edge" });

            let ttftMs = 0;
            let reply = "";

            for await (const raw of handle.events) {
              const part = raw as StreamPart;
              if (part.type === "text-delta" && part.delta) {
                if (ttftMs === 0) ttftMs = performance.now() - runStart;
                reply += part.delta;
                write(sseLine(part.delta));
              }
            }

            await handle;
            const totalMs = performance.now() - runStart;

            write(
              sseEvent(
                "meta",
                JSON.stringify({
                  ttftMs: Math.round(ttftMs),
                  totalMs: Math.round(totalMs),
                  cold,
                  sessionId,
                  replyLength: reply.length,
                }),
              ),
            );
            controller.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            write(sseEvent("error", JSON.stringify({ message: msg })));
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
