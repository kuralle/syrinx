// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket, { WebSocketServer } from "ws";
import { Route, VoiceAgentSession, type UserAudioReceivedPacket } from "@asyncdot/voice";
import { pcm16SamplesToBytes } from "@asyncdot/voice/audio";
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

type NetworkProfile = "clean" | "jittery" | "bursty";

export interface BrowserJitterSmokeResult {
  readonly ok: boolean;
  readonly networkProfile?: NetworkProfile;
  readonly metricsEvents?: number;
  readonly lastMetrics?: {
    readonly turnId?: string;
    readonly e2eMs?: number;
    readonly firstAudioPlayedMs?: number;
  };
  readonly minPlaybackLeadMs?: number;
  readonly audioPlaybackErrors?: number;
  readonly receivedAssistantAudioFrames?: number;
  readonly error?: string;
}

export interface BrowserJitterEvaluationInput {
  readonly browser: BrowserJitterSmokeResult;
  readonly networkProfile: NetworkProfile;
  readonly proxyMaxUplinkGapMs: number;
  readonly proxyMaxDownlinkGapMs: number;
}

export function interFrameDelays(profile: NetworkProfile): readonly number[] {
  if (profile === "jittery") return [35, 5, 45, 10, 30, 15, 20];
  if (profile === "bursty") return [0, 0, 60, 0, 0, 60, 20];
  return [20, 20, 20, 20, 20, 20, 20];
}

export function evaluateBrowserJitterSmoke(input: BrowserJitterEvaluationInput): string[] {
  const failures: string[] = [];
  const browser = input.browser;
  if (!browser.ok) failures.push(`browser reported failure: ${browser.error ?? "unknown"}`);
  if (!browser.receivedAssistantAudioFrames || browser.receivedAssistantAudioFrames < 1) {
    failures.push(`browser received too few assistant audio frames: ${String(browser.receivedAssistantAudioFrames)}`);
  }
  if (browser.audioPlaybackErrors && browser.audioPlaybackErrors > 0) {
    failures.push(`browser assistant audio playback errors: ${String(browser.audioPlaybackErrors)}`);
  }
  if (!browser.metricsEvents || browser.metricsEvents < 1) {
    failures.push("browser did not receive metrics events");
  }
  if (!browser.lastMetrics?.turnId) failures.push("metrics missing turn correlation id");
  if (typeof browser.lastMetrics?.e2eMs !== "number" || browser.lastMetrics.e2eMs <= 0) {
    failures.push("metrics missing voice-to-voice e2eMs");
  }
  if (input.networkProfile !== "clean" && input.proxyMaxUplinkGapMs <= 20) {
    failures.push(`${input.networkProfile} profile did not produce measurable uplink jitter`);
  }
  if (input.networkProfile !== "clean" && input.proxyMaxDownlinkGapMs <= 20) {
    failures.push(`${input.networkProfile} profile did not produce measurable downlink jitter`);
  }
  if (
    input.networkProfile !== "clean"
    && typeof browser.minPlaybackLeadMs === "number"
    && browser.minPlaybackLeadMs <= 0
  ) {
    failures.push("browser jitter buffer did not report positive playback lead");
  }
  if (typeof browser.minPlaybackLeadMs === "number" && browser.minPlaybackLeadMs < -10) {
    failures.push(`playback lead ${String(browser.minPlaybackLeadMs)}ms indicates an audible gap`);
  }
  return failures;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `browser-jitter-${runId}`);
  const baselinePath = join(runDir, "baseline.json");
  await mkdir(runDir, { recursive: true });

  const networkProfile = readNetworkProfile();
  const received: UserAudioReceivedPacket[] = [];
  let respondedContextId: string | null = null;
  const session = new VoiceAgentSession({ plugins: {} });
  session.bus.on("user.audio_received", (pkt) => {
    const audio = pkt as UserAudioReceivedPacket;
    received.push(audio);
    if (respondedContextId !== null || received.length < 3) return;
    respondedContextId = audio.contextId;
    const contextId = audio.contextId;
    const now = Date.now();
    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId,
      timestampMs: now - 400,
    });
    session.bus.push(Route.Main, {
      kind: "stt.result",
      contextId,
      timestampMs: now - 200,
      text: "browser jitter smoke",
      confidence: 0.99,
    });
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId,
      timestampMs: now - 100,
      text: "ack",
    });
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId,
      timestampMs: now,
      audio: pcm16SamplesToBytes(generateTone(TARGET_SAMPLE_RATE_HZ, 440, 0.8)),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId,
      timestampMs: now + 1,
    });
  });

  const voiceServer = await createVoiceWebSocketServer({
    port: 0,
    browserOpusDownlink: false,
    createSession: () => session,
    contextId: () => `browser-jitter-${Date.now().toString(36)}`,
    inputSampleRateHz: TARGET_SAMPLE_RATE_HZ,
  });
  const voiceAddress = voiceServer.address();
  if (!voiceAddress || typeof voiceAddress === "string") throw new Error("Expected TCP websocket address");

  const upstreamUrl = `ws://127.0.0.1:${String(voiceAddress.port)}/ws`;
  const proxy = await createImpairingProxy(upstreamUrl, networkProfile);

  const httpServer = await startPageServer();
  const httpAddress = httpServer.address();
  if (!httpAddress || typeof httpAddress === "string") throw new Error("Expected TCP browser smoke address");

  const userDataDir = await mkdtemp(join(tmpdir(), "syrinx-browser-jitter-"));
  let chrome: ChildProcess | null = null;
  try {
    const pageUrl = `http://127.0.0.1:${String(httpAddress.port)}/?ws=${encodeURIComponent(proxy.url)}`;
    const chromePort = await findFreePort();
    chrome = launchChrome(pageUrl, chromePort, userDataDir);
    const target = await waitForPageTarget(chromePort, pageUrl, 10_000);
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      const browserResult = await runBrowserJitterConsoleSmoke(cdp, 20_000);
      let receiveError = "";
      await waitForReceivedAudio(received, 20_000).catch((err: unknown) => {
        receiveError = err instanceof Error ? err.message : String(err);
      });
      const failures = evaluateBrowserJitterSmoke({
        browser: browserResult,
        networkProfile,
        proxyMaxUplinkGapMs: proxy.maxUplinkGapMs,
        proxyMaxDownlinkGapMs: proxy.maxDownlinkGapMs,
      });
      if (receiveError) failures.push(receiveError);
      const result = {
        scenario: "browser_jitter_downlink_impairment",
        generatedAt,
        transport: "browser_websocket",
        networkProfile,
        proxyMaxUplinkGapMs: proxy.maxUplinkGapMs,
        proxyMaxDownlinkGapMs: proxy.maxDownlinkGapMs,
        qualityGate: {
          passed: failures.length === 0,
          failures,
        },
        browser: browserResult,
        received: {
          frames: received.length,
          contextIds: [...new Set(received.map((pkt) => pkt.contextId))],
        },
        artifacts: {
          runDir: relative(PKG_ROOT, runDir),
          baselinePath: relative(PKG_ROOT, baselinePath),
        },
      };
      await writeFile(baselinePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(JSON.stringify(result, null, 2));
      if (failures.length > 0) throw new Error(`browser jitter smoke failed: ${failures.join("; ")}`);
    } finally {
      cdp.close();
    }
  } finally {
    await terminateChrome(chrome);
    await proxy.close();
    await closeHttpServer(httpServer);
    await voiceServer.close();
    await rm(userDataDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
}

function readNetworkProfile(): NetworkProfile {
  const raw = process.env["SYRINX_BROWSER_NETWORK_PROFILE"]?.trim().toLowerCase()
    ?? process.env["SYRINX_EMULATED_NETWORK_PROFILE"]?.trim().toLowerCase()
    ?? "jittery";
  if (raw === "clean" || raw === "jittery" || raw === "bursty") return raw;
  throw new Error(`unsupported browser network profile: ${raw}`);
}

async function createImpairingProxy(
  upstreamUrl: string,
  profile: NetworkProfile,
): Promise<{ url: string; maxUplinkGapMs: number; maxDownlinkGapMs: number; close: () => Promise<void> }> {
  const delays = [...interFrameDelays(profile)];
  let delayIndex = 0;
  const stats = {
    maxUplinkGapMs: 0,
    previousUplinkAt: 0,
    maxDownlinkGapMs: 0,
    previousDownlinkAt: 0,
  };
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const upstreamSockets = new Set<WebSocket>();

  wss.on("connection", (clientSocket) => {
    const upstream = new WebSocket(upstreamUrl);
    upstreamSockets.add(upstream);
    const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

    upstream.on("open", () => {
      for (const frame of pending.splice(0)) {
        upstream.send(frame.data, { binary: frame.isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      void forwardDownlink(data, isBinary);
    });
    upstream.on("close", () => clientSocket.close());
    upstream.on("error", () => clientSocket.close());

    clientSocket.on("message", (data, isBinary) => {
      void forwardUplink(data, isBinary);
    });
    clientSocket.on("close", () => upstream.close());
    clientSocket.on("error", () => upstream.close());

    async function forwardDownlink(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
      if (isBinary) {
        const delayMs = delays[delayIndex % delays.length] ?? 20;
        delayIndex += 1;
        await sleep(delayMs);
        const now = Date.now();
        if (stats.previousDownlinkAt > 0) {
          stats.maxDownlinkGapMs = Math.max(stats.maxDownlinkGapMs, now - stats.previousDownlinkAt);
        }
        stats.previousDownlinkAt = now;
      }
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data, { binary: isBinary });
    }

    async function forwardUplink(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
      if (isBinary || isAudioJson(data)) {
        const delayMs = delays[delayIndex % delays.length] ?? 20;
        delayIndex += 1;
        await sleep(delayMs);
        const now = Date.now();
        if (stats.previousUplinkAt > 0) {
          stats.maxUplinkGapMs = Math.max(stats.maxUplinkGapMs, now - stats.previousUplinkAt);
        }
        stats.previousUplinkAt = now;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else pending.push({ data, isBinary });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP proxy address");

  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    get maxUplinkGapMs() {
      return stats.maxUplinkGapMs;
    },
    get maxDownlinkGapMs() {
      return stats.maxDownlinkGapMs;
    },
    close: async () => {
      for (const socket of upstreamSockets) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await closeHttpServer(server);
    },
  };
}

function isAudioJson(data: WebSocket.RawData): boolean {
  if (!Buffer.isBuffer(data) || data.length > 4096) return false;
  try {
    const parsed = JSON.parse(data.toString()) as { type?: string };
    return parsed.type === "audio";
  } catch {
    return false;
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
      .then((html) => res.end(html))
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
  return spawn(chromePath, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${userDataDir}`,
    pageUrl,
  ], { stdio: ["ignore", "pipe", "pipe"] });
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

async function runBrowserJitterConsoleSmoke(cdp: CdpClient, timeoutMs: number): Promise<BrowserJitterSmokeResult> {
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
      "window.__syrinxReviewState && window.__syrinxReviewState.metricsEvents >= 1",
      timeoutMs,
    );
    await sleep(2500);
    const response = await cdp.send("Runtime.evaluate", {
      expression: "window.__syrinxReviewState",
      returnByValue: true,
    }) as { result?: { value?: Omit<BrowserJitterSmokeResult, "ok"> } };
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
    if (received.length >= 3) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for browser websocket audio packets");
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
      if (msg.error) pending.reject(new Error(msg.error.message ?? "Chrome DevTools Protocol error"));
      else pending.resolve(msg.result);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
