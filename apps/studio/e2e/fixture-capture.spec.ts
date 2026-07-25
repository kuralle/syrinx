// SPDX-License-Identifier: MIT
//
// LDT-4's done-condition, without a human at a microphone.
//
// Chrome can substitute a WAV file for the microphone
// (`--use-file-for-fake-audio-capture`), so getUserMedia, the capture graph, the
// resampler, the recorder and the uplink all run for real — only the physical mic
// is replaced. That makes this a STRONGER check than a person talking: the input
// is byte-identical every run, so a transcript change means the code changed.
//
// The audio fed in is the same fixture `hello-voice-agent.ts` replays, so the
// expected transcript is already known independently of this test.
//
// Requires a live dev:server on 4173 (which also serves the built studio):
//   pnpm -C apps/studio build
//   pnpm -C examples/02-hello-voice-headless dev:server
//   pnpm -C apps/studio exec playwright test

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const SPOKEN_WAV = join(
  REPO_ROOT,
  "examples/02-hello-voice-headless/test/fixtures/university-cs-masters-deadline.wav",
);

/** What the fixture WAV says, per examples/02-hello-voice-headless/src/hello-voice-agent.ts. */
const EXPECTED_PHRASE = /application deadline/i;

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream", // auto-grant, so no permission prompt to click
      `--use-file-for-fake-audio-capture=${SPOKEN_WAV}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
  permissions: ["microphone"],
});

test("captures a spoken turn and saves it as a replayable fixture", async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.goto("http://127.0.0.1:4173/");
  await page.getByRole("button", { name: "Connect" }).click();

  // The fake device plays the WAV into the capture graph; the server's endpointer
  // decides the turn ended. Wait for the transcript the agent actually heard rather
  // than a fixed sleep — this is the same discipline as the unit tests.
  const userTurn = page.getByTestId("transcript-user").first();
  await expect(userTurn).toContainText(EXPECTED_PHRASE, { timeout: 60_000 });

  // The save button must be enabled: audio was recorded and the turn was transcribed.
  const save = page.getByTestId("save-fixture").first();
  await expect(save).toBeEnabled();

  // Two concurrent waitForEvent("download") calls both resolve with the FIRST
  // download, so collect from the event instead — a fixture is a pair, and this
  // has to prove both files arrived.
  const downloads: import("@playwright/test").Download[] = [];
  page.on("download", (d) => downloads.push(d));
  await save.click();
  await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(2);

  const wavDownload = downloads.find((d) => d.suggestedFilename().endsWith(".wav"));
  const jsonDownload = downloads.find((d) => d.suggestedFilename().endsWith(".json"));
  expect(wavDownload, "expected a .wav download").toBeDefined();
  expect(jsonDownload, "expected a .json sidecar download").toBeDefined();

  const wavPath = await wavDownload!.path();
  const jsonPath = await jsonDownload!.path();
  // Both halves must share a stem, or you cannot tell which sidecar belongs to
  // which audio in a folder of captures.
  expect(wavDownload!.suggestedFilename().slice(0, -4)).toBe(
    jsonDownload!.suggestedFilename().slice(0, -5),
  );

  const wav = readFileSync(wavPath);
  const sidecar = JSON.parse(readFileSync(jsonPath, "utf8")) as {
    format: string;
    expectedTranscript?: string;
    audioFile: string;
    audio: { sampleRateHz: number; channels: number; encoding: string; durationMs: number };
    capture: { inputSampleRateHz?: number; wsUrl?: string };
  };

  // The sidecar describes the WAV beside it.
  expect(sidecar.format).toBe("syrinx.fixture.v1");
  expect(sidecar.audioFile).toBe(wavDownload!.suggestedFilename());
  expect(sidecar.expectedTranscript).toMatch(EXPECTED_PHRASE);
  expect(sidecar.capture.inputSampleRateHz).toBe(16_000);

  // The WAV is real, decodable, at the negotiated rate, and holds actual speech —
  // not a header with silence behind it, which would pass a format check and fail
  // every replay.
  expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(sidecar.audio.sampleRateHz).toBe(16_000);

  const samples = new Int16Array(
    wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.byteLength),
  );
  let peak = 0;
  let nonZero = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a > 64) nonZero += 1;
  }
  expect(samples.length, "captured audio must not be empty").toBeGreaterThan(1600);
  expect(peak, "captured audio must contain speech, not silence").toBeGreaterThan(500);
  expect(nonZero / samples.length, "most of the capture should be non-silent").toBeGreaterThan(0.1);

  // Persist the pair where the replay step can find it. The round trip
  // (capture -> replay -> same transcript) is LDT-4's actual done-condition, and it
  // spans two processes, so the handoff has to be a real file.
  const outDir = join(REPO_ROOT, "runs", "captured-fixture");
  mkdirSync(outDir, { recursive: true });
  await wavDownload!.saveAs(join(outDir, "captured.wav"));
  await jsonDownload!.saveAs(join(outDir, "captured.json"));
  await testInfo.attach("fixture.wav", { path: wavPath, contentType: "audio/wav" });
  await testInfo.attach("fixture.json", { path: jsonPath, contentType: "application/json" });

  expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});
