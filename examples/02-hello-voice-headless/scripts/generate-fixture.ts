// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { WaveFile } from "wavefile";

import { ensureRepoRootDotenv } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as any;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const OUT = join(PKG_ROOT, "public", "fixtures", "hello.wav");
const LINE = "Hi, what's the weather like in San Francisco today?";

async function synthesizeFixture(text: string, voiceId: string): Promise<Uint8Array[]> {
  const apiKey = process.env["CARTESIA_API_KEY"]?.trim();
  if (!apiKey) throw new Error("CARTESIA_API_KEY is required");

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `wss://api.cartesia.ai/tts/websocket?api_key=${apiKey}&cartesia_version=2024-06-10`,
    );
    const chunks: Uint8Array[] = [];
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Cartesia fixture synthesis timeout"));
    }, 30_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        model_id: "sonic-2-2025-03-07",
        transcript: text,
        voice: { mode: "id", id: voiceId },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
        language: "en",
        context_id: randomUUID(),
      }));
    });
    ws.on("message", (data: { toString(): string }) => {
      const msg = JSON.parse(data.toString());
      if (msg.data) chunks.push(new Uint8Array(Buffer.from(msg.data, "base64")));
      if (msg.done) {
        clearTimeout(timeout);
        ws.close();
        resolve(chunks);
      }
    });
    ws.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();

  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    options: {
      voice: { type: "string" },
    },
  });

  const voiceId =
    typeof parsed.values.voice === "string"
      ? parsed.values.voice
      : process.env["CARTESIA_VOICE_ID"]?.trim();
  if (!voiceId) throw new Error("pass --voice <id> or set CARTESIA_VOICE_ID");

  const chunks = await synthesizeFixture(LINE, voiceId);
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const mergedBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    mergedBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const samples = new Int16Array(mergedBytes.buffer, mergedBytes.byteOffset, mergedBytes.byteLength / 2);
  const wav = new WaveFile();
  wav.fromScratch(1, 16000, "16", samples);

  await mkdir(dirname(OUT), { recursive: true });
  const wavBytes = Buffer.from(wav.toBuffer());
  await writeFile(OUT, wavBytes);

  const kb = (wavBytes.byteLength / 1024).toFixed(1);
  console.log(`wrote ${OUT} (${kb} KB, ${String(samples.length)} samples @16k)`);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
