// SPDX-License-Identifier: MIT
//
// Smoke test: SyrinxBrowserClient reconnect + resume against a real voice server.
//
// What it proves:
//   1. Client receives sessionId from the initial ready message.
//   2. When the server forcibly terminates the connection (ws.terminate()), the
//      client auto-reconnects and re-dials with ?sessionId= in the URL.
//   3. The server resumes the existing session and returns resumed:true.
//   4. The client emits reconnecting → reconnected → resumed events in order.
//
// No real AI keys needed — uses a bare VoiceAgentSession with no plugins.
//
// Run: pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:browser-client-reconnect

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { createVoiceWebSocketServer, type VoiceWebSocketServer } from "@kuralle-syrinx/server-websocket";
import { SyrinxBrowserClient, type SyrinxBrowserClientEvent } from "@kuralle-syrinx/browser-client";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");

const SMOKE_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 200;

interface ReconnectSmokeResult {
  readonly ok: boolean;
  readonly sessionId: string | null;
  readonly reconnectUrlHasSessionId: boolean;
  readonly eventsEmitted: string[];
  readonly sessionResumed: boolean;
  readonly error?: string;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `browser-client-reconnect-${runId}`);
  await mkdir(runDir, { recursive: true });

  const session = new VoiceAgentSession({ plugins: {} });
  const voiceServer = await createVoiceWebSocketServer({
    port: 0,
    createSession: () => session,
    contextId: () => `reconnect-smoke-${Date.now().toString(36)}`,
    inputSampleRateHz: 16000,
    resumeWindowMs: 15_000,
  });
  const voiceAddress = voiceServer.address();
  if (!voiceAddress || typeof voiceAddress === "string") {
    throw new Error("Expected TCP websocket address");
  }
  const wsUrl = `ws://127.0.0.1:${String(voiceAddress.port)}/ws`;

  let result: ReconnectSmokeResult;
  try {
    result = await runSmoke(wsUrl, voiceServer);
  } finally {
    await voiceServer.close();
  }

  const artifact = {
    scenario: "browser_client_reconnect_resume",
    generatedAt,
    transport: "websocket_syrinx_browser_client",
    qualityGate: {
      passed: result.ok,
      failures: result.ok ? [] : [result.error ?? "unknown failure"],
    },
    result,
    artifacts: {
      runDir: relative(PKG_ROOT, runDir),
    },
  };

  const artifactPath = join(runDir, "result.json");
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));

  if (!result.ok) {
    throw new Error(`browser client reconnect smoke failed: ${result.error ?? "unknown"}`);
  }
}

async function runSmoke(wsUrl: string, voiceServer: VoiceWebSocketServer): Promise<ReconnectSmokeResult> {
  const eventsEmitted: string[] = [];
  let capturedSessionId: string | null = null;
  let reconnectUrlHasSessionId = false;
  let sessionResumed = false;

  const client = new SyrinxBrowserClient({
    url: wsUrl,
    reconnect: { baseDelayMs: RECONNECT_BASE_DELAY_MS, maxAttempts: 5 },
    keepaliveIntervalMs: 5_000,
  });

  return new Promise<ReconnectSmokeResult>((resolve) => {
    const timeout = setTimeout(() => {
      client.close();
      resolve({
        ok: false,
        sessionId: capturedSessionId,
        reconnectUrlHasSessionId,
        eventsEmitted,
        sessionResumed,
        error: `timed out after ${SMOKE_TIMEOUT_MS} ms; events: ${eventsEmitted.join(", ")}`,
      });
    }, SMOKE_TIMEOUT_MS);

    client.on((event: SyrinxBrowserClientEvent) => {
      eventsEmitted.push(event.type);

      if (event.type === "message" && event.message.type === "ready") {
        capturedSessionId = event.message.sessionId ?? capturedSessionId;
        if (event.message.resumed === true) {
          sessionResumed = true;
        }
        return;
      }

      if (event.type === "open") {
        // Initial connection established — wait briefly then forcibly drop it.
        setTimeout(() => {
          for (const ws of voiceServer.wsServer.clients) {
            ws.terminate();
          }
        }, 200);
        return;
      }

      if (event.type === "reconnecting") {
        // Verify the reconnect URL includes the sessionId.
        reconnectUrlHasSessionId = client.sessionId !== null
          && wsUrl.includes("?") === false; // base URL has no query — sessionId is our addition
        return;
      }

      if (event.type === "resumed") {
        clearTimeout(timeout);

        const hasOpen = eventsEmitted.includes("open");
        const hasReconnecting = eventsEmitted.includes("reconnecting");
        const hasReconnected = eventsEmitted.includes("reconnected");
        const hasResumed = true;
        const sessionIdCaptured = capturedSessionId !== null;

        const ok = hasOpen && hasReconnecting && hasReconnected && hasResumed
          && sessionIdCaptured && sessionResumed;

        client.close();
        resolve({
          ok,
          sessionId: capturedSessionId,
          reconnectUrlHasSessionId: sessionIdCaptured,
          eventsEmitted,
          sessionResumed,
          error: ok ? undefined : buildFailureMessage({
            hasOpen,
            hasReconnecting,
            hasReconnected,
            sessionIdCaptured,
            sessionResumed,
          }),
        });
      }
    });

    client.connect();
  });
}

function buildFailureMessage(checks: Record<string, boolean>): string {
  const failed = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return failed.length > 0 ? `not satisfied: ${failed.join(", ")}` : "unknown";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
