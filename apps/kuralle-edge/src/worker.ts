import { createFullUniversityRuntime } from "./agent";

interface Env {
  readonly OPENAI_API_KEY: string;
}

interface StreamPart {
  readonly type: string;
  readonly delta?: string;
}

let rtPromise: ReturnType<typeof createFullUniversityRuntime> | undefined;

function getRt(env: Env) {
  return (rtPromise ??= createFullUniversityRuntime({ apiKey: env.OPENAI_API_KEY }));
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

    if (url.pathname === "/chat" && request.method === "GET") {
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
            const { runtime, ingestMs } = await getRt(env);
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
                  ingestMs: cold ? Math.round(ingestMs) : 0,
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
