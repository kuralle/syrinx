// SPDX-License-Identifier: MIT
//
// session_start baseline (434b3bf1). Measures the ONE thing the server cannot see:
// connect -> `ready` round trip, cold and warm.
//
// Why client-side: the DO constructor and the withVoice onConnect wrap both run BEFORE
// runVoiceEdgeWebSocketConnection is entered, so `connectedAtMs` is stamped after the
// cold wake has already completed. The server literally cannot observe its own wake.
// A fresh sessionId forces a cold DO; reusing it hits the warm one.
//
// The server-side stage decomposition is read separately from `wrangler tail`
// (SESSION_START lines), because session_start is not forwarded on the wire.
//
// Usage: SYRINX_WS_URL=wss://host/ws npx tsx scripts/run-session-start-baseline.ts [--reps 5]

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

interface Sample { readonly kind: "cold" | "warm"; readonly sessionId: string; readonly connectMs: number; readonly readyMs: number }

async function once(baseUrl: string, sessionId: string, kind: "cold" | "warm"): Promise<Sample> {
  const t0 = Date.now();
  const ws = new WebSocket(`${baseUrl}?sessionId=${encodeURIComponent(sessionId)}`);
  let connectMs = -1;
  return await new Promise<Sample>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("timed out waiting for ready")); }, 30_000);
    ws.on("open", () => { connectMs = Date.now() - t0; });
    ws.on("message", (raw: unknown) => {
      let msg: { type?: string };
      try { msg = JSON.parse(String(raw)) as { type?: string }; } catch { return; }
      if (msg.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`server error frame: ${JSON.stringify(msg)}`));
        return;
      }
      if (msg.type !== "ready") return;
      clearTimeout(timer);
      const readyMs = Date.now() - t0;
      ws.close();
      resolve({ kind, sessionId, connectMs, readyMs });
    });
    ws.on("error", (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

function stats(values: readonly number[]): { n: number; min: number; median: number; max: number } {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, min: s[0]!, median: s[Math.floor(s.length / 2)]!, max: s[s.length - 1]! };
}

async function main(): Promise<void> {
  const baseUrl = (process.env["SYRINX_WS_URL"] ?? "").trim();
  if (!baseUrl) throw new Error("SYRINX_WS_URL is required (wss://host/ws)");
  const reps = Number(arg("reps", "5"));

  const cold: Sample[] = [];
  const warm: Sample[] = [];
  for (let i = 0; i < reps; i += 1) {
    const sessionId = `sstart-${randomUUID()}`;
    const c = await once(baseUrl, sessionId, "cold");   // fresh id -> cold DO
    cold.push(c);
    console.log(`cold  #${i + 1}  connect=${c.connectMs}ms  ready=${c.readyMs}ms  (${sessionId.slice(0, 14)}…)`);
    await new Promise((r) => setTimeout(r, 500));
    const w = await once(baseUrl, sessionId, "warm");   // same id -> warm DO
    warm.push(w);
    console.log(`warm  #${i + 1}  connect=${w.connectMs}ms  ready=${w.readyMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }

  const result = {
    proof: "session_start client-side baseline (connect -> ready)",
    url: baseUrl,
    reps,
    cold: { connectMs: stats(cold.map((s) => s.connectMs)), readyMs: stats(cold.map((s) => s.readyMs)) },
    warm: { connectMs: stats(warm.map((s) => s.connectMs)), readyMs: stats(warm.map((s) => s.readyMs)) },
    samples: [...cold, ...warm],
  };
  console.log(`\n=== SESSION_START CLIENT BASELINE ===`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
