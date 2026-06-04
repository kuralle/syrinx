// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";

type WorkersWebSocket = WebSocket & { accept(): void };

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TURN_DETECTION_FIXTURE = join(
  REPO_ROOT,
  "examples/02-hello-voice-headless/test/fixtures/gemini-turn-detection/02-reset-password.wav",
);
const WORKER_INPUT_RATE_HZ = 16000;

loadRepoEnv();
const liveEnv = {
  DEEPGRAM_API_KEY: process.env["DEEPGRAM_API_KEY"]?.trim() ?? "",
  OPENAI_API_KEY: process.env["OPENAI_API_KEY"]?.trim() ?? "",
  CARTESIA_API_KEY: process.env["CARTESIA_API_KEY"]?.trim() ?? "",
  CARTESIA_VOICE_ID: process.env["CARTESIA_VOICE_ID"]?.trim() ?? "",
};
const hasLiveKeys = Boolean(liveEnv.DEEPGRAM_API_KEY && liveEnv.OPENAI_API_KEY && liveEnv.CARTESIA_API_KEY);
// The live turn hits paid, non-deterministic provider APIs, so it is opt-in
// (SYRINX_LIVE_WORKER_TEST=1) rather than running on every `pnpm -r test`.
// Run it with: pnpm --filter @asyncdot/voice-server-workers test:live
const liveTurnEnabled = hasLiveKeys && process.env["SYRINX_LIVE_WORKER_TEST"] === "1";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function buildWorker(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "syrinx-worker-"));
  tempDirs.push(tmp);
  const outfile = join(tmp, "worker.js");
  await build({
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    outfile,
    logLevel: "silent",
  });
  return readFile(outfile, "utf8");
}

function newMiniflare(script: string, bindings: Record<string, string>): Miniflare {
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      VOICE_CONVERSATIONS: { className: "VoiceConversation", useSQLite: true },
    },
    bindings,
  });
}

describe("VoiceConversation worker runtime", () => {
  // Deterministic, no provider keys: proves the edge bundle boots inside workerd
  // and accepts a WebSocketPair upgrade before any provider session starts.
  it("boots in workerd and accepts a WebSocket upgrade", async () => {
    const script = await buildWorker();
    const mf = newMiniflare(script, {});
    try {
      const health = await mf.dispatchFetch("http://localhost/health");
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("ok");

      const response = await mf.dispatchFetch("http://localhost/ws?sessionId=boot-smoke", {
        headers: { Upgrade: "websocket" },
      });
      expect(response.status).toBe(101);
      const ws = (response as unknown as Response & { webSocket?: WorkersWebSocket }).webSocket;
      expect(ws).toBeTruthy();
      ws!.accept();
      ws!.close();
    } finally {
      await mf.dispose();
    }
  }, 20_000);

  // Live: drives a real STT -> LLM -> TTS turn through real providers inside
  // workerd. Skipped when provider keys are absent so offline CI stays green.
  it.skipIf(!liveTurnEnabled)(
    "drives a real audio turn through Deepgram + OpenAI + Cartesia in workerd",
    async () => {
      expect(existsSync(TURN_DETECTION_FIXTURE)).toBe(true);
      const pcm16 = readWav16kMono(TURN_DETECTION_FIXTURE);
      const script = await buildWorker();
      const mf = newMiniflare(script, liveEnv);
      try {
        const response = await mf.dispatchFetch("http://localhost/ws?sessionId=live-turn", {
          headers: { Upgrade: "websocket" },
        });
        expect(response.status).toBe(101);
        const ws = (response as unknown as Response & { webSocket?: WorkersWebSocket }).webSocket;
        expect(ws).toBeTruthy();

        const messages: Array<string | ArrayBuffer> = [];
        ws!.addEventListener("message", (event) => {
          messages.push(event.data as string | ArrayBuffer);
        });
        ws!.accept();

        // Wait for the session to come up (provider sockets connected) before audio.
        // Surface a provider init error (e.g. bad key, unreachable socket) instead
        // of a bare timeout.
        try {
          await waitFor(() => messages.some((m) => typeof m === "string" && m.includes('"type":"ready"')), 20_000);
        } catch {
          throw new Error(`session never became ready: ${firstSessionError(messages) ?? "no error reported"}`);
        }

        // Stream the fixture as 20ms PCM16 frames, base64 JSON audio messages.
        const frameSamples = (WORKER_INPUT_RATE_HZ / 1000) * 20; // 320 samples = 640 bytes
        let sequence = 0;
        for (let offset = 0; offset < pcm16.length; offset += frameSamples) {
          const frame = pcm16.subarray(offset, Math.min(offset + frameSamples, pcm16.length));
          sequence += 1;
          ws!.send(JSON.stringify({
            type: "audio",
            audio: int16ToBase64(frame),
            sampleRateHz: WORKER_INPUT_RATE_HZ,
            sequence,
          }));
          await sleep(20);
        }

        // Real Deepgram transcript for the "reset password" utterance.
        await waitFor(
          () => messages.some((m) => typeof m === "string" && m.includes('"type":"stt_output"')),
          15_000,
        );
        // Real Cartesia TTS audio frames back from the LLM reply.
        await waitFor(
          () => messages.some((m) => typeof m === "string" && m.includes('"type":"tts_chunk"')),
          30_000,
        );

        const transcript = extractTranscript(messages);
        expect(transcript.length).toBeGreaterThan(0);
        expect(messages.some((m) => m instanceof ArrayBuffer && m.byteLength > 0)).toBe(true);

        // eslint-disable-next-line no-console
        console.log(`[live-turn] STT transcript: ${JSON.stringify(transcript)}`);
        ws!.close();
      } finally {
        await mf.dispose();
      }
    },
    90_000,
  );
});

function firstSessionError(messages: ReadonlyArray<string | ArrayBuffer>): string | null {
  for (const m of messages) {
    if (typeof m !== "string") continue;
    try {
      const parsed = JSON.parse(m) as { type?: string; message?: string };
      if (parsed.type === "error" && typeof parsed.message === "string") return parsed.message;
    } catch {
      // not JSON — ignore
    }
  }
  return null;
}

function extractTranscript(messages: ReadonlyArray<string | ArrayBuffer>): string {
  for (const m of messages) {
    if (typeof m !== "string") continue;
    try {
      const parsed = JSON.parse(m) as { type?: string; transcript?: string };
      if (parsed.type === "stt_output" && typeof parsed.transcript === "string") return parsed.transcript;
    } catch {
      // not JSON — ignore
    }
  }
  return "";
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting for worker websocket output");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  return Buffer.from(bytes).toString("base64");
}

/** Minimal PCM16 WAV reader that returns samples resampled to 16 kHz mono. */
function readWav16kMono(path: string): Int16Array {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let sampleRate = 24000;
  let dataStart = -1;
  let dataLen = 0;
  let pos = 12; // skip RIFF/WAVE header
  while (pos + 8 <= buf.byteLength) {
    const id = String.fromCharCode(buf[pos]!, buf[pos + 1]!, buf[pos + 2]!, buf[pos + 3]!);
    const size = view.getUint32(pos + 4, true);
    if (id === "fmt ") sampleRate = view.getUint32(pos + 8 + 4, true);
    if (id === "data") {
      dataStart = pos + 8;
      dataLen = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error(`no data chunk in WAV: ${path}`);
  const sampleCount = Math.floor(dataLen / 2);
  const src = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) src[i] = view.getInt16(dataStart + i * 2, true);
  return sampleRate === WORKER_INPUT_RATE_HZ ? src : resampleLinear(src, sampleRate, WORKER_INPUT_RATE_HZ);
}

function resampleLinear(src: Int16Array, fromHz: number, toHz: number): Int16Array {
  const outLen = Math.max(1, Math.round((src.length * toHz) / fromHz));
  const out = new Int16Array(outLen);
  const ratio = (src.length - 1) / Math.max(1, outLen - 1);
  for (let i = 0; i < outLen; i += 1) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const frac = x - i0;
    out[i] = Math.round(src[i0]! * (1 - frac) + src[i1]! * frac);
  }
  return out;
}

/** Load DEEPGRAM/OPENAI/CARTESIA keys from the repo-root .env if not already set. */
function loadRepoEnv(): void {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
