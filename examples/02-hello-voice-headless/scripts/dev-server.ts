// SPDX-License-Identifier: MIT
//
// Local dev server — serves the Studio and drives YOUR agent over a microphone.
//
//   pnpm dev:server                                  # the university demo agent
//   pnpm dev:server --agent ./src/hello-voice-agent.ts#createHelloVoiceAgent
//
// The agent argument is `<module>#<namedExport>`; the export is a zero-arg
// factory returning a VoiceAgentSession. Omit `#name` for a default export.

import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createVoiceWebSocketServer, installGracefulShutdown } from "@kuralle-syrinx/server-websocket";
import type { VoiceAgentSession } from "@kuralle-syrinx/core";

import { coerceGoogleGenAiKey, ensureRepoRootDotenv } from "../src/run-one-turn.js";
import { createUniversitySupportSession, type UniversitySupportTtsProvider } from "../src/university-support-agent.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const INPUT_SAMPLE_RATE = 16000;

// Where the Studio's built assets live. Resolved through the package rather than
// a hand-built node_modules path so it survives pnpm's symlinked store; falls
// back to the minimal page when the Studio has not been built yet.
const STUDIO_DIST = join(REPO_ROOT, "apps", "studio", "dist");
const FALLBACK_HTML = join(REPO_ROOT, "packages", "browser-client", "index.html");

const OBS_DIR = process.env["SYRINX_OBS_DIR"]?.trim() || "/tmp/syrinx-obs";
const OBSERVED_KINDS = [
  "vad.speech_started",
  "vad.speech_ended",
  "stt.result",
  "stt.error",
  "eos.turn_complete",
  "turn.change",
  "tts.end",
  "interrupt.detected",
  "interrupt.committed",
  "interrupt.suppressed_short_speech",
] as const;

interface ObservedPacket {
  readonly contextId?: string;
  readonly text?: string;
  readonly name?: string;
  readonly message?: string;
  readonly value?: unknown;
}

/** Per-session turn-taking trace. Best-effort: never break a session to log it. */
function observeSession(session: VoiceAgentSession, obsId: string): void {
  let obsReady = true;
  try {
    mkdirSync(OBS_DIR, { recursive: true });
  } catch {
    obsReady = false;
  }
  const file = join(OBS_DIR, `${obsId}.jsonl`);
  const write = (line: Record<string, unknown>): void => {
    if (!obsReady) return;
    try {
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), obsId, ...line })}\n`);
    } catch {
      /* best-effort observability */
    }
  };
  const bus = session.bus as unknown as {
    on(kind: string, handler: (pkt: ObservedPacket) => void): () => void;
  };
  write({ kind: "session.start" });
  for (const kind of OBSERVED_KINDS) {
    bus.on(kind, (pkt) => {
      write({ kind, contextId: pkt.contextId, text: pkt.text?.slice(0, 100), message: pkt.message?.slice(0, 160) });
    });
  }
  const ttsStarted = new Set<string>();
  bus.on("tts.audio", (pkt) => {
    const ctx = pkt.contextId ?? "";
    if (ttsStarted.has(ctx)) return;
    ttsStarted.add(ctx);
    write({ kind: "tts.first_audio", contextId: ctx });
  });
  bus.on("metric.conversation", (pkt) => {
    if (!pkt.name || !/finalize|interrupt|barge|turn/i.test(pkt.name)) return;
    write({ kind: "metric", name: pkt.name, contextId: pkt.contextId, value: pkt.value });
  });
}

export type SessionFactory = () => VoiceAgentSession | Promise<VoiceAgentSession>;

/**
 * Resolve `--agent <module>[#export]` to a factory.
 *
 * Fails loudly and specifically. A dev server that silently falls back to a
 * different agent than the one you asked for is worse than one that refuses to
 * start — you would debug the wrong agent.
 */
async function resolveAgentFactory(spec: string | undefined): Promise<{ factory: SessionFactory; label: string }> {
  if (!spec) {
    const ttsProvider = inferTtsProvider();
    requireEnv("DEEPGRAM_API_KEY");
    requireEnv("GOOGLE_GENERATIVE_AI_API_KEY");
    if (ttsProvider === "cartesia") requireEnv("CARTESIA_API_KEY");
    return {
      label: `bundled university-support demo (tts: ${ttsProvider})`,
      factory: () =>
        createUniversitySupportSession({ inputSampleRate: INPUT_SAMPLE_RATE, profile: "interactive", ttsProvider }),
    };
  }

  const [modulePath, exportName] = spec.split("#");
  if (!modulePath) throw new Error(`--agent needs a module path, got: ${spec}`);
  const abs = isAbsolute(modulePath) ? modulePath : resolve(PKG_ROOT, modulePath);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;

  const picked = exportName ? mod[exportName] : (mod["default"] ?? mod["createSession"]);
  if (typeof picked !== "function") {
    const available = Object.keys(mod).filter((k) => typeof mod[k] === "function");
    throw new Error(
      `${abs} has no callable export ${exportName ? `"${exportName}"` : "(default or createSession)"}. ` +
        `Callable exports: ${available.length > 0 ? available.join(", ") : "(none)"}`,
    );
  }
  return { factory: picked as SessionFactory, label: `${modulePath}${exportName ? `#${exportName}` : ""}` };
}

// SYRINX_REVIEW_TTS, not SYRINX_DEV_TTS: it is the package-wide switch that 14 other
// scripts already read, and it configures the *bundled demo agent* — pass --agent and it
// stops applying. Renaming it here would silently ignore what a user already set.
function inferTtsProvider(): UniversitySupportTtsProvider {
  const requested = process.env["SYRINX_REVIEW_TTS"]?.trim().toLowerCase();
  if (requested === "gemini" || requested === "cartesia") return requested;
  return process.env["CARTESIA_API_KEY"]?.trim() ? "cartesia" : "gemini";
}

function readPort(): number {
  const raw = process.env["SYRINX_DEV_PORT"]?.trim();
  if (!raw) return 4173;
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error(`invalid SYRINX_DEV_PORT: ${raw}`);
  return port;
}

function requireEnv(name: string): void {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function loadStudioHtml(): Promise<{ html: string; source: string }> {
  try {
    return { html: await readFile(join(STUDIO_DIST, "index.html"), "utf8"), source: "apps/studio/dist" };
  } catch {
    // Say which page is being served. Silently serving the minimal fallback
    // while the user expects the Studio is a confusing five minutes.
    return { html: await readFile(FALLBACK_HTML, "utf8"), source: "browser-client/index.html (run `pnpm -C apps/studio build` for the full Studio)" };
  }
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".map": "application/json; charset=utf-8",
};

/** A file under the Studio's dist, or undefined. Refuses to escape that directory. */
function readAsset(pathname: string): { body: Buffer; contentType: string } | undefined {
  const resolved = resolve(STUDIO_DIST, `.${pathname}`);
  // `..` in a URL must not reach outside dist — this server binds to loopback by
  // default but SYRINX_DEV_HOST can expose it.
  if (resolved !== STUDIO_DIST && !resolved.startsWith(STUDIO_DIST + sep)) return undefined;
  try {
    if (!statSync(resolved).isFile()) return undefined;
    return {
      body: readFileSync(resolved),
      contentType: CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream",
    };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();

  const { factory, label } = await resolveAgentFactory(flag(process.argv.slice(2), "--agent"));
  const port = readPort();
  const host = process.env["SYRINX_DEV_HOST"]?.trim() || "127.0.0.1";
  const { html, source } = await loadStudioHtml();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, agent: label, inputSampleRate: INPUT_SAMPLE_RATE }));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    // The Studio is a bundle: its HTML is inert without /assets/*.js. Serving only
    // index.html renders a blank page whose 404s are invisible unless you open the
    // console — the page looks served and is not.
    const asset = readAsset(url.pathname);
    if (asset) {
      response.writeHead(200, { "content-type": asset.contentType, "cache-control": "no-store" });
      response.end(asset.body);
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
    contextId: () => `dev-${Date.now().toString(36)}`,
    createSession: async () => {
      const session = await factory();
      observeSession(session, `sess-${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`);
      return session;
    },
  });

  const address = voiceServer.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  console.log(`Syrinx dev server: http://${host}:${String(address.port)}`);
  console.log(`WebSocket endpoint: ws://${host}:${String(address.port)}/ws`);
  console.log(`Agent: ${label}`);
  console.log(`Serving: ${source}`);
  console.log(`Turn-taking trace: ${OBS_DIR}`);

  installGracefulShutdown(voiceServer, { drainDeadlineMs: 10_000, onClosed: () => process.exit(0) });
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
