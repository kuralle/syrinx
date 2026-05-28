// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";
import { Route, VoiceAgentSession, type UserAudioReceivedPacket } from "@asyncdot/voice";
import { createVoiceWebSocketServer } from "@asyncdot/voice-server-websocket";

const CHROME_PATHS = [
  process.env["CHROME_PATH"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome",
  "chromium",
].filter((path): path is string => Boolean(path));

const TARGET_SAMPLE_RATE_HZ = 16000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const REVIEW_HTML = join(REPO_ROOT, "packages", "voice-client-browser", "index.html");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");

interface BrowserSmokeResult {
  readonly ok: boolean;
  readonly readySessionId?: string;
  readonly audioContextSampleRateHz?: number;
  readonly targetSampleRateHz?: number;
  readonly sentFrames?: number;
  readonly sentEnvelopeFrames?: number;
  readonly sentBytes?: number;
  readonly startedTurns?: number;
  readonly contextIds?: readonly string[];
  readonly receivedAssistantAudioFrames?: number;
  readonly receivedAssistantEnvelopeFrames?: number;
  readonly receivedAssistantBytes?: number;
  readonly assistantSampleRateHz?: number;
  readonly audioClearEvents?: number;
  readonly audioPlaybackErrors?: number;
  readonly error?: string;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `browser-runtime-${runId}`);
  const baselinePath = join(runDir, "baseline.json");
  await mkdir(runDir, { recursive: true });

  const received: UserAudioReceivedPacket[] = [];
  let emittedAssistantAudio = false;
  const session = new VoiceAgentSession({ plugins: {} });
  session.bus.on("user.audio_received", (pkt) => {
    const audio = pkt as UserAudioReceivedPacket;
    received.push(audio);
    if (emittedAssistantAudio || received.length < 3) return;
    emittedAssistantAudio = true;
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: audio.contextId,
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(generateTone(TARGET_SAMPLE_RATE_HZ, 440, 0.5)),
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: audio.contextId,
      timestampMs: Date.now(),
    });
    setTimeout(() => {
      session.bus.push(Route.Main, {
        kind: "interrupt.tts",
        contextId: audio.contextId,
        timestampMs: Date.now(),
        reason: "browser_runtime_smoke",
      });
    }, 100);
  });

  const voiceServer = await createVoiceWebSocketServer({
    port: 0,
    createSession: () => session,
    contextId: () => `browser-runtime-${Date.now().toString(36)}`,
    inputSampleRateHz: TARGET_SAMPLE_RATE_HZ,
  });
  const voiceAddress = voiceServer.address();
  if (!voiceAddress || typeof voiceAddress === "string") throw new Error("Expected TCP websocket address");

  const httpServer = await startPageServer();
  const httpAddress = httpServer.address();
  if (!httpAddress || typeof httpAddress === "string") throw new Error("Expected TCP browser smoke address");

  const userDataDir = await mkdtemp(join(tmpdir(), "syrinx-browser-smoke-"));
  let chrome: ChildProcess | null = null;
  try {
    const pageUrl = `http://127.0.0.1:${String(httpAddress.port)}/?ws=${encodeURIComponent(`ws://127.0.0.1:${String(voiceAddress.port)}/ws`)}`;
    const chromePort = await findFreePort();
    chrome = launchChrome(pageUrl, chromePort, userDataDir);
    const target = await waitForPageTarget(chromePort, pageUrl, 10_000);
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      const browserResult = await runBrowserReviewConsoleSmoke(cdp, 12_000);
      let receiveError = "";
      await waitForReceivedAudio(received, 12_000).catch((err: unknown) => {
        receiveError = err instanceof Error ? err.message : String(err);
      });
      const totalBytes = received.reduce((sum, pkt) => sum + pkt.audio.byteLength, 0);
      const failures = evaluate(browserResult, received, receiveError);
      const result = {
        scenario: "browser_runtime_capture_to_websocket",
        generatedAt,
        transport: "browser_websocket",
        qualityGate: {
          passed: failures.length === 0,
          failures,
        },
        browser: browserResult,
        received: {
          frames: received.length,
          bytes: totalBytes,
          contextIds: [...new Set(received.map((pkt) => pkt.contextId))],
          error: receiveError || undefined,
        },
        artifacts: {
          runDir: relative(PKG_ROOT, runDir),
          baselinePath: relative(PKG_ROOT, baselinePath),
        },
      };
      await writeFile(baselinePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(JSON.stringify(result, null, 2));
      if (failures.length > 0) throw new Error(`browser runtime capture smoke failed: ${failures.join("; ")}`);
    } finally {
      cdp.close();
    }
  } finally {
    await terminateChrome(chrome);
    await closeHttpServer(httpServer);
    await voiceServer.close();
    await rm(userDataDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
}

function startPageServer(): Promise<HttpServer> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/favicon")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    void readFile(REVIEW_HTML, "utf8")
      .then((html) => {
        res.end(html);
      })
      .catch((err: unknown) => {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(err instanceof Error ? err.message : String(err));
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function launchChrome(pageUrl: string, port: number, userDataDir: string): ChildProcess {
  const chromePath = CHROME_PATHS[0];
  if (!chromePath) throw new Error("No Chrome/Chromium path configured");
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${userDataDir}`,
    pageUrl,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  chrome.stderr?.setEncoding("utf8");
  chrome.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    if (process.env["SYRINX_BROWSER_SMOKE_DEBUG"] === "1") process.stderr.write(text);
  });
  return chrome;
}

async function terminateChrome(chrome: ChildProcess | null): Promise<void> {
  if (!chrome || chrome.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.kill("SIGKILL");
      resolve();
    }, 2000);
    chrome.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    chrome.kill("SIGTERM");
  });
}

async function waitForPageTarget(port: number, pageUrl: string, timeoutMs: number): Promise<{ webSocketDebuggerUrl: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
      const targets = await response.json() as Array<{ url?: string; type?: string; webSocketDebuggerUrl?: string }>;
      const target = targets.find((item) => item.type === "page" && item.url === pageUrl && item.webSocketDebuggerUrl);
      if (target?.webSocketDebuggerUrl) return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for Chrome DevTools page target");
}

async function runBrowserReviewConsoleSmoke(cdp: CdpClient, timeoutMs: number): Promise<BrowserSmokeResult> {
  try {
    await waitForExpression(cdp, "Boolean(window.__syrinxReviewState && document.getElementById('connectBtn'))", timeoutMs);
    await cdp.send("Runtime.evaluate", {
      expression: "document.getElementById('connectBtn').click()",
      returnByValue: true,
    });
    await waitForExpression(cdp, "!document.getElementById('talkBtn').disabled", timeoutMs);
    await cdp.send("Runtime.evaluate", {
      expression: "document.getElementById('talkBtn').click()",
      returnByValue: true,
    });
    await waitForExpression(cdp, "window.__syrinxReviewState && window.__syrinxReviewState.sentFrames >= 3", timeoutMs);
    await waitForExpression(
      cdp,
      "window.__syrinxReviewState && window.__syrinxReviewState.receivedAssistantAudioFrames >= 1",
      timeoutMs,
    );
    await waitForExpression(
      cdp,
      "window.__syrinxReviewState && window.__syrinxReviewState.audioClearEvents >= 1",
      timeoutMs,
    );
    await cdp.send("Runtime.evaluate", {
      expression: "document.getElementById('talkBtn').click()",
      returnByValue: true,
    });
    const response = await cdp.send("Runtime.evaluate", {
      expression: "window.__syrinxReviewState",
      returnByValue: true,
    }) as { result?: { value?: Omit<BrowserSmokeResult, "ok"> } };
    return { ok: true, ...response.result?.value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function waitForExpression(cdp: CdpClient, expression: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    }) as { result?: { value?: boolean } };
    if (response.result?.value === true) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for browser expression: ${expression}`);
}

async function waitForReceivedAudio(received: readonly UserAudioReceivedPacket[], timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (received.length >= 2) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for browser websocket audio packets");
}

function evaluate(result: BrowserSmokeResult, received: readonly UserAudioReceivedPacket[], receiveError: string): string[] {
  const failures: string[] = [];
  if (!result.ok) failures.push(`browser reported failure: ${result.error ?? "unknown"}`);
  if (receiveError) failures.push(receiveError);
  if (result.targetSampleRateHz !== TARGET_SAMPLE_RATE_HZ) failures.push(`browser target rate was ${String(result.targetSampleRateHz)}`);
  if (!result.audioContextSampleRateHz || result.audioContextSampleRateHz <= 0) failures.push("browser did not report AudioContext sample rate");
  if (!result.sentFrames || result.sentFrames < 2) failures.push(`browser sent too few audio frames: ${String(result.sentFrames)}`);
  if (result.sentEnvelopeFrames !== result.sentFrames) {
    failures.push(
      `browser did not send every microphone frame as a Syrinx envelope: ${String(result.sentEnvelopeFrames)}/${String(result.sentFrames)}`,
    );
  }
  if (!result.receivedAssistantAudioFrames || result.receivedAssistantAudioFrames < 1) {
    failures.push(`browser received too few assistant audio frames: ${String(result.receivedAssistantAudioFrames)}`);
  }
  if (result.receivedAssistantEnvelopeFrames !== result.receivedAssistantAudioFrames) {
    failures.push(
      `browser did not decode every assistant frame as a Syrinx envelope: ${String(result.receivedAssistantEnvelopeFrames)}/${String(result.receivedAssistantAudioFrames)}`,
    );
  }
  if (!result.receivedAssistantBytes || result.receivedAssistantBytes <= 0) failures.push("browser received no assistant PCM bytes");
  if (result.assistantSampleRateHz !== TARGET_SAMPLE_RATE_HZ) {
    failures.push(`browser assistant sample rate was ${String(result.assistantSampleRateHz)}`);
  }
  if (!result.audioClearEvents || result.audioClearEvents < 1) failures.push("browser did not observe assistant audio clear");
  if (result.audioPlaybackErrors && result.audioPlaybackErrors > 0) {
    failures.push(`browser assistant audio playback errors: ${String(result.audioPlaybackErrors)}`);
  }
  if (!result.sentBytes || result.sentBytes <= 0) failures.push("browser sent no PCM bytes");
  if (received.length < 2) failures.push(`server received too few audio packets: ${String(received.length)}`);
  const contextIds = result.contextIds ?? [];
  if (!result.startedTurns || result.startedTurns < 1) {
    failures.push(`browser allocated unexpected turn count: ${String(result.startedTurns)}`);
  }
  if (contextIds.length < 1) failures.push("browser did not send a capture context id");
  if (received.some((pkt) => !contextIds.includes(pkt.contextId))) failures.push("server received audio for unexpected context id");
  if (received.some((pkt) => pkt.audio.byteLength % 2 !== 0)) failures.push("server received odd-byte PCM audio");
  return failures;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof msg.id !== "number") return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? "Chrome DevTools Protocol error"));
        return;
      }
      pending.resolve(msg.result);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new CdpClient(socket);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await closeHttpServer(server);
  return address.port;
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateTone(sampleRateHz: number, frequencyHz: number, durationSeconds: number): Int16Array {
  const samples = new Int16Array(Math.round(sampleRateHz * durationSeconds));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRateHz) * 8000);
  }
  return samples;
}

function pcm16SamplesToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
