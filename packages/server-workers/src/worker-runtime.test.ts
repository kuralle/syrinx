// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { decodeMuLawToPcm16, encodePcm16ToMuLaw } from "@kuralle-syrinx/core/audio";

const execFileAsync = promisify(execFile);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  VECTORIZE: {},
};
const hasLiveKeys = Boolean(liveEnv.DEEPGRAM_API_KEY && liveEnv.OPENAI_API_KEY);
// The live turn hits paid, non-deterministic provider APIs, so it is opt-in
// (SYRINX_LIVE_WORKER_TEST=1) rather than running on every `pnpm -r test`.
// Run it with: pnpm --filter @kuralle-syrinx/server-workers test:live
const liveTurnEnabled = hasLiveKeys && process.env["SYRINX_LIVE_WORKER_TEST"] === "1";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function buildWorker(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "syrinx-worker-"));
  tempDirs.push(tmp);
  await execFileAsync(
    "npx",
    ["wrangler", "deploy", "--dry-run", "--outdir", tmp, "-c", "wrangler.jsonc"],
    { cwd: PKG_ROOT },
  );
  return readFile(join(tmp, "worker.js"), "utf8");
}

function newMiniflare(script: string, bindings: Record<string, unknown>): Miniflare {
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      VOICE_CONVERSATIONS: { className: "VoiceConversation", useSQLite: true },
      TWILIO_VOICE_CONVERSATIONS: { className: "TwilioVoiceConversation", useSQLite: true },
    },
    vectorize: {
      VECTORIZE: { dimensions: 1536, metric: "cosine", index_name: "kuralle-university-kb" },
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
    "drives a real audio turn through Deepgram STT + kuralle + Deepgram TTS in workerd",
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
        // Real Deepgram TTS audio frames back from the kuralle reply.
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

describe("TwilioVoiceConversation worker runtime", () => {
  // Deterministic, no keys: the Twilio Media Streams front accepts a WS upgrade at /twilio
  // through withVoice(Agent, { transport: "twilio" }) — the cf-agents telephony front bundles
  // and boots in workerd.
  it("accepts a Twilio Media Streams WebSocket upgrade at /twilio", async () => {
    const script = await buildWorker();
    const mf = newMiniflare(script, {});
    try {
      const response = await mf.dispatchFetch("http://localhost/twilio?sessionId=twilio-boot", {
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

  // Deterministic: the Twilio Voice webhook returns TwiML that bridges the call to /twilio.
  it("returns <Connect><Stream> TwiML from /incoming-call pointing at /twilio", async () => {
    const script = await buildWorker();
    const mf = newMiniflare(script, {});
    try {
      const res = await mf.dispatchFetch("http://localhost/incoming-call", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "CallSid=CA0123456789abcdef&From=%2B15551234567",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/xml");
      const twiml = await res.text();
      expect(twiml).toContain("<Connect>");
      expect(twiml).toContain("<Stream");
      // The Twilio CallSid becomes the /twilio sessionId.
      expect(twiml).toContain("/twilio?sessionId=CA0123456789abcdef");
    } finally {
      await mf.dispose();
    }
  }, 20_000);

  // Live: EMULATE A PSTN CALL — speak the Twilio Media Streams protocol (connected/start/media
  // as base64 μ-law 8 kHz) at /twilio and assert the agent answers with non-silent μ-law media
  // frames on the phone leg. No carrier, no phone number — the protocol is just a WebSocket.
  it.skipIf(!liveTurnEnabled)(
    "answers an emulated Twilio Media Streams call end-to-end in workerd",
    async () => {
      expect(existsSync(TURN_DETECTION_FIXTURE)).toBe(true);
      const pcm16k = readWav16kMono(TURN_DETECTION_FIXTURE);
      const pcm8k = downsampleTo8k(pcm16k);
      const script = await buildWorker();
      const mf = newMiniflare(script, liveEnv);
      try {
        const response = await mf.dispatchFetch("http://localhost/twilio?sessionId=twilio-live", {
          headers: { Upgrade: "websocket" },
        });
        expect(response.status).toBe(101);
        const ws = (response as unknown as Response & { webSocket?: WorkersWebSocket }).webSocket;
        expect(ws).toBeTruthy();

        let downlinkFrames = 0;
        let downlinkPeak = 0;
        let clearReceived = false;
        ws!.addEventListener("message", (event) => {
          const data = event.data as string | ArrayBuffer;
          if (typeof data !== "string" || !data.startsWith("{")) return;
          const msg = JSON.parse(data) as Record<string, unknown>;
          if (msg.event === "media") {
            downlinkFrames += 1;
            const media = msg.media as { payload?: string } | undefined;
            if (media?.payload) {
              const pcm = decodeMuLawToPcm16(base64ToBytes(media.payload));
              for (const s of pcm) downlinkPeak = Math.max(downlinkPeak, Math.abs(s));
            }
          } else if (msg.event === "clear") {
            clearReceived = true;
          }
        });
        ws!.accept();

        const streamSid = "MZtwiliolivesmoke";
        ws!.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
        ws!.send(JSON.stringify({
          event: "start",
          streamSid,
          start: { streamSid, callSid: "CAtwiliolivesmoke", mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } },
        }));

        const sendMulaw = (frame: Int16Array): void => {
          ws!.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: bytesToBase64(encodePcm16ToMuLaw(frame)) },
          }));
        };

        const frameSamples8k = 160; // 20ms at 8 kHz
        for (let offset = 0; offset < pcm8k.length; offset += frameSamples8k) {
          const frame = new Int16Array(frameSamples8k);
          frame.set(pcm8k.subarray(offset, Math.min(offset + frameSamples8k, pcm8k.length)));
          sendMulaw(frame);
          await sleep(20);
        }

        // Pad silence until the agent answers (Deepgram endpointing + kuralle + TTS).
        const deadline = Date.now() + 60_000;
        while (downlinkFrames === 0 && Date.now() < deadline) {
          sendMulaw(new Int16Array(frameSamples8k));
          await sleep(20);
        }

        ws!.send(JSON.stringify({ event: "stop", streamSid }));
        ws!.close();

        // eslint-disable-next-line no-console
        console.log(`[twilio-live] downlink media frames=${downlinkFrames} peak=${downlinkPeak} clear=${clearReceived}`);
        expect(downlinkFrames).toBeGreaterThan(0);
        expect(downlinkPeak).toBeGreaterThan(100); // non-silent answer on the phone leg
      } finally {
        await mf.dispose();
      }
    },
    120_000,
  );
});

function downsampleTo8k(samples: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(samples.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = samples[i * 2]!;
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

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

/** Load DEEPGRAM/OPENAI keys from the repo-root .env if not already set. */
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
