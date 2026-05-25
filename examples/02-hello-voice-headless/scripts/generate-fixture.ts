// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "node:util";
import { WaveFile } from "wavefile";

import { CartesiaTTS } from "@asyncdot/voice-tts-cartesia";

import { ensureRepoRootDotenv } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const OUT = join(PKG_ROOT, "public", "fixtures", "hello.wav");

const LINE = "Hi, what's the weather like in San Francisco today?";

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
  if (!voiceId) {
    console.error("error: pass --voice <id> or set CARTESIA_VOICE_ID");
    process.exit(1);
  }

  const tts = new CartesiaTTS({ voiceId });
  const frames = await tts.synthesize(LINE);

  let total = 0;
  for (const f of frames) {
    total += f.data.length;
  }
  const merged = new Int16Array(total);
  let o = 0;
  for (const f of frames) {
    merged.set(f.data, o);
    o += f.data.length;
  }

  const wav = new WaveFile();
  wav.fromScratch(1, 16000, "16", merged);

  await mkdir(dirname(OUT), { recursive: true });
  const wavBytes = Buffer.from(wav.toBuffer());

  await writeFile(OUT, wavBytes);

  const kb = (wavBytes.byteLength / 1024).toFixed(1);
  console.log(`wrote ${OUT} (${kb} KB, ${String(merged.length)} samples @16k)`);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
