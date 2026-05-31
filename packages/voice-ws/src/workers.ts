// SPDX-License-Identifier: MIT
//
// Cloudflare Workers socket adapter. The built-in WebSocket constructor can't
// set request headers, so auth-header provider connections (Deepgram's
// `Authorization: Token`, Cartesia's `X-API-Key`) are opened with a `fetch`
// upgrade and the returned `response.webSocket`, then `accept()`-ed before use.
//
// Pattern from Cloudflare's own agents/voice package (workers-ai-providers.ts):
//   const resp = await fetch(url, { headers: { Upgrade: "websocket", ...auth } });
//   const ws = resp.webSocket; ws.accept();

import type { ManagedSocket } from "./index.js";
import { wrapWebSocket, type WebSocketLike } from "./web-socket.js";

/** The Workers WebSocket adds accept(); the upgrade response carries it. */
type WorkersWebSocket = WebSocketLike & { accept(): void };
interface UpgradeResponse {
  readonly status?: number;
  readonly webSocket?: WorkersWebSocket | null;
}
type WorkersFetch = (url: string, init: { headers: Record<string, string> }) => Promise<UpgradeResponse>;

/** Open an auth-header WebSocket from a Worker via fetch upgrade. Async — await before use. */
export async function createWorkersSocket(url: string, headers: Record<string, string>): Promise<ManagedSocket> {
  const doFetch = (globalThis as { fetch?: WorkersFetch }).fetch;
  if (!doFetch) throw new Error("fetch is not available in this runtime");
  const resp = await doFetch(url, { headers: { ...headers, Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`WebSocket upgrade failed (status ${String(resp.status ?? "unknown")})`);
  ws.accept();
  return wrapWebSocket(ws);
}
