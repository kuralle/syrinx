// SPDX-License-Identifier: MIT
//
// Local HTTP server that holds a response open for a configurable duration.
// Used by the media-lane slow-tool fixture so tool execution performs real socket
// I/O rather than a mocked timer.

import { createServer, type Server } from "node:http";

export interface MediaLaneDelayServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartMediaLaneDelayServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly defaultDelayMs?: number;
}

export function parseDelayMsFromUrl(url: URL): number {
  const raw = url.searchParams.get("ms") ?? url.searchParams.get("delayMs");
  if (!raw) return NaN;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
}

export async function startMediaLaneDelayServer(
  options: StartMediaLaneDelayServerOptions = {},
): Promise<MediaLaneDelayServer> {
  const host = options.host ?? "127.0.0.1";
  const defaultDelayMs = options.defaultDelayMs ?? 2000;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== "/delay") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
      return;
    }

    const requested = parseDelayMsFromUrl(url);
    const delayMs = Number.isFinite(requested) ? requested : defaultDelayMs;
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify({ ok: true, delayMs })}\n`);
    }, delayMs);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolveListen());
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP delay-server address");
  const port = address.port;
  const url = `http://${host}:${String(port)}/delay?ms=${String(defaultDelayMs)}`;

  return {
    url,
    port,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
  });
}
