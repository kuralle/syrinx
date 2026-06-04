// SPDX-License-Identifier: MIT
//
// Short, single-sentence user utterances for turn-detection / latency testing.
// Unlike the dense university-support monologues (~16-30s each), these are ~2-4s
// so end-of-utterance detection, STT-final timing, and LLM-TTFT can be exercised
// without long audio. Additive: lives in its own fixture directory.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GEMINI_UNIVERSITY_FIXTURE_DIR,
  geminiTtsModel,
  geminiTtsVoiceName,
  readPcm16Wav,
  synthesizeFixture,
} from "./generate-gemini-university-fixtures.js";
import { coerceGoogleGenAiKey, ensureRepoRootDotenv } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(SCRIPT_DIR, "..");
export const GEMINI_TURN_DETECTION_FIXTURE_DIR = join(
  PKG_ROOT,
  "test",
  "fixtures",
  "gemini-turn-detection",
);
export const GEMINI_TURN_DETECTION_MANIFEST_PATH = join(
  GEMINI_TURN_DETECTION_FIXTURE_DIR,
  "manifest.json",
);

// Sanity: the shared university dir must resolve next to ours (same fixtures root).
void GEMINI_UNIVERSITY_FIXTURE_DIR;

export interface GeminiTurnDetectionFixture {
  readonly id: string;
  readonly text: string;
  readonly path: string;
}

/**
 * Short single-sentence user turns. Each is one clear, self-contained request a
 * caller would speak in a single breath — a clean end-of-utterance boundary.
 */
export const GEMINI_TURN_DETECTION_FIXTURES: readonly GeminiTurnDetectionFixture[] = [
  {
    id: "01-library-hours",
    text: "What time does the library close today?",
    path: join(GEMINI_TURN_DETECTION_FIXTURE_DIR, "01-library-hours.wav"),
  },
  {
    id: "02-reset-password",
    text: "Can you help me reset my student portal password?",
    path: join(GEMINI_TURN_DETECTION_FIXTURE_DIR, "02-reset-password.wav"),
  },
  {
    id: "03-order-status",
    text: "I'd like to check the status of my transcript request.",
    path: join(GEMINI_TURN_DETECTION_FIXTURE_DIR, "03-order-status.wav"),
  },
  {
    id: "04-transfer-billing",
    text: "Please transfer me to the billing office.",
    path: join(GEMINI_TURN_DETECTION_FIXTURE_DIR, "04-transfer-billing.wav"),
  },
  {
    id: "05-confirm-yes",
    text: "Yes, that's correct.",
    path: join(GEMINI_TURN_DETECTION_FIXTURE_DIR, "05-confirm-yes.wav"),
  },
  {
    id: "06-thanks-goodbye",
    text: "Thanks, that's all I needed.",
    path: join(GEMINI_TURN_DETECTION_FIXTURE_DIR, "06-thanks-goodbye.wav"),
  },
];

export async function ensureGeminiTurnDetectionFixtures(): Promise<void> {
  ensureRepoRootDotenv();
  const missing = GEMINI_TURN_DETECTION_FIXTURES.filter((fixture) => !existsSync(fixture.path));
  let apiKey = "";
  if (missing.length > 0) {
    coerceGoogleGenAiKey();
    apiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim() ?? "";
    if (!apiKey) {
      throw new Error(
        `GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY is required to synthesize missing fixtures: ${
          missing.map((fixture) => fixture.id).join(", ")
        }`,
      );
    }
  }

  await mkdir(GEMINI_TURN_DETECTION_FIXTURE_DIR, { recursive: true });
  const manifest = {
    generatedAt: readExistingGeneratedAt() ?? new Date().toISOString(),
    provider: "gemini-tts",
    model: geminiTtsModel(),
    voiceName: geminiTtsVoiceName(),
    sampleRateHz: 24000,
    purpose: "turn-detection-latency",
    fixtures: [] as Array<{ id: string; text: string; path: string; durationMs: number; bytes: number }>,
  };

  for (const fixture of GEMINI_TURN_DETECTION_FIXTURES) {
    if (!existsSync(fixture.path)) {
      console.log(`synthesizing ${fixture.id}`);
      const wav = await synthesizeFixture(fixture.text, apiKey);
      await writeFile(fixture.path, Buffer.from(wav.toBuffer()));
      console.log(`wrote ${fixture.path}`);
    } else {
      console.log(`reusing ${fixture.id}`);
    }
    const pcm = readPcm16Wav(fixture.path);
    manifest.fixtures.push({
      id: fixture.id,
      text: fixture.text,
      path: fixture.path.replace(`${PKG_ROOT}/`, ""),
      durationMs: Math.round((pcm.samples.length / pcm.sampleRate) * 1000),
      bytes: readFileSync(fixture.path).byteLength,
    });
  }

  await writeFile(
    GEMINI_TURN_DETECTION_MANIFEST_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function readExistingGeneratedAt(): string | null {
  if (!existsSync(GEMINI_TURN_DETECTION_MANIFEST_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(GEMINI_TURN_DETECTION_MANIFEST_PATH, "utf8")) as {
      generatedAt?: unknown;
    };
    return typeof parsed.generatedAt === "string" ? parsed.generatedAt : null;
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void ensureGeminiTurnDetectionFixtures().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
