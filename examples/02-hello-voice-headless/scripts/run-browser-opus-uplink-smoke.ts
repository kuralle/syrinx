// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Route, VoiceAgentSession, type UserAudioReceivedPacket } from "@asyncdot/voice";
import { createVoiceWebSocketServer } from "@asyncdot/voice-server-websocket";
import { SyrinxBrowserClient, WebSocketClientTransport, type ClientTransport, type ClientTransportHandlers } from "@asyncdot/voice-client-browser";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");
const TARGET_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;
const FRAME_MS = 20;
const SMOKE_DURATION_MS = 2_000;

class MeteredTransport implements ClientTransport {
  uplinkBytes = 0;
  private readonly inner = new WebSocketClientTransport();
  private handlers: ClientTransportHandlers = {};

  get connected(): boolean {
    return this.inner.connected;
  }

  setHandlers(handlers: ClientTransportHandlers): void {
    this.handlers = handlers;
    this.inner.setHandlers({
      onOpen: () => handlers.onOpen?.(),
      onClose: (code, reason) => handlers.onClose?.(code, reason),
      onError: (error) => handlers.onError?.(error),
      onMessage: (data) => handlers.onMessage?.(data),
      onAudio: (data) => handlers.onAudio?.(data),
    });
  }

  connect(url: string): void {
    this.inner.connect(url);
  }

  disconnect(code?: number, reason?: string): void {
    this.inner.disconnect(code, reason);
  }

  sendAudio(data: Uint8Array | ArrayBuffer): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.uplinkBytes += bytes.byteLength;
    this.inner.sendAudio(bytes);
  }

  sendJson(value: unknown): void {
    const json = JSON.stringify(value);
    this.uplinkBytes += Buffer.byteLength(json, "utf8");
    this.inner.sendJson(value);
  }
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `browser-opus-uplink-${runId}`);
  await mkdir(runDir, { recursive: true });

  const received: UserAudioReceivedPacket[] = [];
  const session = new VoiceAgentSession({ plugins: {} });
  session.bus.on("user.audio_received", (pkt) => {
    received.push(pkt as UserAudioReceivedPacket);
  });

  const server = await createVoiceWebSocketServer({
    port: 0,
    createSession: () => session,
    contextId: () => `browser-opus-smoke-${Date.now().toString(36)}`,
    inputSampleRateHz: TARGET_SAMPLE_RATE_HZ,
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP websocket address");

  const url = `ws://127.0.0.1:${String(address.port)}/ws`;
  const metered = new MeteredTransport();
  let readyEncoding = "unknown";
  const failures: string[] = [];

  const client = new SyrinxBrowserClient({
    url,
    transport: metered,
    reconnect: false,
    keepaliveIntervalMs: false,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ready timeout")), 10_000);
    client.on((event) => {
      if (event.type === "message" && event.message.type === "ready") {
        readyEncoding = event.message.audio?.encoding ?? "unknown";
        clearTimeout(timer);
        resolve();
      }
      if (event.type === "error") {
        clearTimeout(timer);
        reject(event.error);
      }
    });
    client.connect();
  });

  const framePcm = new Uint8Array(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    const sample = Math.round(8_000 * Math.sin((2 * Math.PI * 440 * i) / TARGET_SAMPLE_RATE_HZ));
    framePcm[i * 2] = sample & 0xff;
    framePcm[i * 2 + 1] = (sample >> 8) & 0xff;
  }
  const pcmBaselineBytes = framePcm.byteLength * Math.floor(SMOKE_DURATION_MS / FRAME_MS);

  const started = Date.now();
  while (Date.now() - started < SMOKE_DURATION_MS) {
    client.sendAudioPcm(framePcm, TARGET_SAMPLE_RATE_HZ, { contextId: "smoke-turn" });
    await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));

  const uplinkBytes = metered.uplinkBytes;
  const decodedBytes = received.reduce((sum, pkt) => sum + pkt.audio.byteLength, 0);
  const uplinkKbps = Math.round((uplinkBytes * 8) / (SMOKE_DURATION_MS / 1000) / 1000);
  const pcmKbps = Math.round((pcmBaselineBytes * 8) / (SMOKE_DURATION_MS / 1000) / 1000);

  if (readyEncoding !== "opus") failures.push(`ready.encoding expected opus, got ${readyEncoding}`);
  if (uplinkBytes === 0) failures.push("no uplink bytes captured");
  if (decodedBytes === 0) failures.push("server decoded zero PCM16 bytes");
  if (uplinkKbps >= pcmKbps * 0.5) {
    failures.push(`uplink not compressed enough: opus~${uplinkKbps} kbps vs pcm baseline~${pcmKbps} kbps`);
  }

  const result = {
    scenario: "browser_opus_uplink_bandwidth",
    generatedAt,
    transport: "browser_websocket",
    readyEncoding,
    uplinkBytes,
    pcmBaselineBytes,
    uplinkKbps,
    pcmBaselineKbps: pcmKbps,
    compressionRatio: pcmBaselineBytes > 0 ? Number((uplinkBytes / pcmBaselineBytes).toFixed(3)) : null,
    decodedServerPcmBytes: decodedBytes,
    qualityGate: { passed: failures.length === 0, failures },
  };

  await writeFile(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  client.close();
  await server.close();

  if (failures.length > 0) {
    throw new Error(`browser opus uplink smoke failed: ${failures.join("; ")}`);
  }
  console.log(JSON.stringify({ ok: true, runDir, ...result }, null, 2));
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
