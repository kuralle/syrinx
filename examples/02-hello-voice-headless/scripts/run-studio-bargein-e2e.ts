// SPDX-License-Identifier: MIT
//
// Tier-3 live proof without a human: drive the deployed Syrinx Studio in headless
// Chrome with a fake microphone (--use-file-for-fake-audio-capture), so the REAL
// studio capture path (getUserMedia → ScriptProcessor → sendFloat32Audio) feeds the
// REAL browser-client energy-VAD against the REAL deployed cascade worker. The fake
// mic speaks a question, waits, then talks over the agent's answer. Playwright's
// WebSocket frame inspection asserts:
//   1. no client_interrupt before the agent starts speaking (no false trigger),
//   2. client_interrupt is sent while the agent is speaking,
//   3. the server answers with agent_interrupted/audio_clear.
//
// Not covered (honest limit): acoustic echo / AEC behavior — the fake capture file
// is clean by construction. Everything else in the chain is the production path.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-cs-masters-deadline.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "studio-bargein-e2e");
const FAKE_MIC_WAV = join(OUTPUT_DIR, "fake-mic.wav");
const SAMPLE_RATE = 16_000;

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PLAYWRIGHT_DIR =
  process.env["SYRINX_PLAYWRIGHT_DIR"]?.trim() || join(homedir(), ".cache", "syrinx-e2e-tools");

interface E2EResult {
  readonly ok: boolean;
  readonly studioUrl: string;
  readonly firstTtsAtMs: number | null;
  readonly clientInterruptAtMs: number | null;
  readonly agentInterruptedAtMs: number | null;
  readonly audioClearReceived: boolean;
  readonly interruptBeforeTts: boolean;
  readonly clientToServerInterruptMs: number | null;
}

function silence(seconds: number): Int16Array {
  return new Int16Array(Math.round(seconds * SAMPLE_RATE));
}

function concatPcm(parts: readonly Int16Array[]): Int16Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

// Fake-mic timeline (starts when getUserMedia attaches, i.e. on session ready):
//   0s        question (~4s)             → normal turn 1
//   +5s gap   (agent reasons + starts speaking ~6-9s absolute, answer plays ~8-12s)
//   then      sustained speech ~8s       → talks over the agent's playout
//   +4s tail  silence
async function composeFakeMicWav(): Promise<void> {
  const question = readPcm16Mono16kWav(FIXTURE_PATH);
  const question16 = new Int16Array(question.buffer, question.byteOffset, question.length);
  const bargeIn = concatPcm([question16, silence(0.3), question16]);
  const timeline = concatPcm([question16, silence(5), bargeIn, silence(4)]);
  const wav = new WaveFile();
  wav.fromScratch(1, SAMPLE_RATE, "16", timeline);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(FAKE_MIC_WAV, Buffer.from(wav.toBuffer()));
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const cascadeUrl = process.env["SYRINX_CF_CASCADE_URL"]?.trim();
  if (!cascadeUrl) throw new Error("SYRINX_CF_CASCADE_URL is required");
  const wsUrl = cascadeUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
  const studioBase = process.env["SYRINX_STUDIO_URL"]?.trim() || "https://syrinx-studio.mithushancj.workers.dev";
  const studioUrl = `${studioBase}/?ws=${encodeURIComponent(wsUrl)}`;
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`missing fixture ${FIXTURE_PATH} — run run-cascade-cf-smoke.ts once to synthesize it`);
  }
  if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found at ${CHROME_PATH}`);

  await composeFakeMicWav();

  const { chromium } = require(join(PLAYWRIGHT_DIR, "node_modules", "playwright-core")) as
    typeof import("playwright-core");

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
  });

  const startedAt = Date.now();
  let firstTtsAtMs: number | null = null;
  let clientInterruptAtMs: number | null = null;
  let agentInterruptedAtMs: number | null = null;
  let audioClearReceived = false;
  let interruptBeforeTts = false;

  try {
    const page = await browser.newPage();
    page.on("websocket", (socket) => {
      if (!socket.url().includes("/ws")) return;
      socket.on("framesent", (frame) => {
        const payload = typeof frame.payload === "string" ? frame.payload : "";
        if (payload.includes("\"client_interrupt\"")) {
          if (firstTtsAtMs === null) interruptBeforeTts = true;
          if (clientInterruptAtMs === null) clientInterruptAtMs = Date.now() - startedAt;
        }
      });
      socket.on("framereceived", (frame) => {
        if (typeof frame.payload !== "string") {
          if (firstTtsAtMs === null) firstTtsAtMs = Date.now() - startedAt;
          return;
        }
        if (frame.payload.includes("\"tts_chunk\"") && firstTtsAtMs === null) {
          firstTtsAtMs = Date.now() - startedAt;
        }
        if (frame.payload.includes("\"audio_clear\"")) audioClearReceived = true;
        if (frame.payload.includes("\"agent_interrupted\"") && agentInterruptedAtMs === null) {
          agentInterruptedAtMs = Date.now() - startedAt;
        }
      });
    });

    await page.goto(studioUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Connect" }).click();

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (agentInterruptedAtMs !== null && clientInterruptAtMs !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await browser.close();
  }

  const clientToServerInterruptMs =
    clientInterruptAtMs !== null && agentInterruptedAtMs !== null
      ? agentInterruptedAtMs - clientInterruptAtMs
      : null;

  const result: E2EResult = {
    ok:
      firstTtsAtMs !== null &&
      clientInterruptAtMs !== null &&
      agentInterruptedAtMs !== null &&
      audioClearReceived &&
      !interruptBeforeTts,
    studioUrl,
    firstTtsAtMs,
    clientInterruptAtMs,
    agentInterruptedAtMs,
    audioClearReceived,
    interruptBeforeTts,
    clientToServerInterruptMs,
  };
  await writeFile(join(OUTPUT_DIR, "summary.json"), JSON.stringify(result, null, 2));

  console.log(`\n=== STUDIO BARGE-IN E2E PASS: ${result.ok ? "YES" : "NO"} ===`);
  console.log(`studio: ${result.studioUrl}`);
  console.log(`first tts at: ${result.firstTtsAtMs}ms`);
  console.log(`client_interrupt sent at: ${result.clientInterruptAtMs}ms`);
  console.log(`agent_interrupted at: ${result.agentInterruptedAtMs}ms`);
  console.log(`audio_clear received: ${result.audioClearReceived}`);
  console.log(`client→server interrupt round-trip: ${result.clientToServerInterruptMs}ms`);
  console.log(`false trigger before tts: ${result.interruptBeforeTts}`);

  if (!result.ok) throw new Error("studio barge-in e2e failed");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
