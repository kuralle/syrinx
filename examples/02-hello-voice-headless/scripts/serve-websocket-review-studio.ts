// SPDX-License-Identifier: MIT

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createVoiceWebSocketServer } from "@asyncdot/voice-server-websocket";

import { coerceGoogleGenAiKey, ensureRepoRootDotenv } from "../src/run-one-turn.js";
import { createUniversitySupportSession, type UniversitySupportTtsProvider } from "../src/university-support-agent.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const STUDIO_HTML = join(REPO_ROOT, "packages", "voice-client-browser", "index.html");
const INPUT_SAMPLE_RATE = 16000;

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const ttsProvider = inferTtsProvider();
  requireEnv("DEEPGRAM_API_KEY");
  requireEnv("GOOGLE_GENERATIVE_AI_API_KEY");
  if (ttsProvider === "cartesia") requireEnv("CARTESIA_API_KEY");

  const port = readPort();
  const host = process.env["SYRINX_REVIEW_HOST"]?.trim() || "127.0.0.1";
  const html = await readFile(STUDIO_HTML, "utf8");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, ttsProvider, inputSampleRate: INPUT_SAMPLE_RATE }));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(html);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  });

  const voiceServer = await createVoiceWebSocketServer({
    server,
    port,
    host,
    path: "/ws",
    contextId: () => `review-${Date.now().toString(36)}`,
    createSession: () => createUniversitySupportSession({
      inputSampleRate: INPUT_SAMPLE_RATE,
      profile: "interactive",
      ttsProvider,
    }),
  });

  const address = voiceServer.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  const origin = `http://${host}:${String(address.port)}`;
  console.log(`Syrinx university review studio: ${origin}`);
  console.log(`WebSocket endpoint: ws://${host}:${String(address.port)}/ws`);
  console.log(`TTS provider: ${ttsProvider}; input PCM: ${String(INPUT_SAMPLE_RATE)} Hz mono s16le`);

  const close = async (): Promise<void> => {
    await voiceServer.close();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
}

function inferTtsProvider(): UniversitySupportTtsProvider {
  const requested = process.env["SYRINX_REVIEW_TTS"]?.trim().toLowerCase();
  if (requested === "gemini" || requested === "cartesia") return requested;
  return process.env["CARTESIA_API_KEY"]?.trim() ? "cartesia" : "gemini";
}

function readPort(): number {
  const raw = process.env["SYRINX_REVIEW_PORT"]?.trim();
  if (!raw) return 4173;
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid SYRINX_REVIEW_PORT: ${raw}`);
  }
  return port;
}

function requireEnv(name: string): void {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
