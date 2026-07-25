// SPDX-License-Identifier: MIT
//
// Replay a fixture captured in the Studio and check it still says what it said.
//
// This is the other half of the loop. Capturing a bad turn is only useful if the
// capture can be re-run later and compared — otherwise it is a recording, not a
// test. Run it against a fixture pair produced by "Save as fixture":
//
//   pnpm -C examples/02-hello-voice-headless exec tsx scripts/replay-fixture.ts \
//     runs/captured-fixture/captured.json
//
// Exit 0 when the replayed transcript matches the captured one, 1 when it drifts.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { ensureRepoRootDotenv, coerceGoogleGenAiKey, runOneTurn } from "../src/run-one-turn.js";

interface FixtureSidecar {
  readonly format: string;
  readonly expectedTranscript?: string;
  readonly audioFile: string;
  readonly audio: { readonly sampleRateHz: number; readonly channels: number; readonly encoding: string };
  readonly capture?: { readonly inputSampleRateHz?: number };
}

/** Compare on words, not punctuation — STT capitalises and punctuates inconsistently. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function main(): void {
  const sidecarArg = process.argv[2];
  if (!sidecarArg) throw new Error("usage: replay-fixture.ts <fixture.json>");
  const sidecarPath = isAbsolute(sidecarArg) ? sidecarArg : resolve(process.cwd(), sidecarArg);

  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as FixtureSidecar;
  if (sidecar.format !== "syrinx.fixture.v1") {
    throw new Error(`unsupported fixture format: ${sidecar.format}`);
  }
  if (sidecar.expectedTranscript === undefined) {
    throw new Error("fixture has no expectedTranscript — nothing to assert against");
  }
  // The sidecar exists so replay conditions can be checked rather than assumed.
  if (sidecar.audio.sampleRateHz !== 16000 || sidecar.audio.channels !== 1) {
    throw new Error(
      `this replay path needs mono 16 kHz; fixture is ${String(sidecar.audio.channels)}ch @ ${String(sidecar.audio.sampleRateHz)} Hz`,
    );
  }

  // Prefer the sibling file the capture actually wrote; fall back to the recorded
  // name for a fixture moved around by hand.
  const dir = dirname(sidecarPath);
  const sibling = join(dir, "captured.wav");
  let wavPath: string;
  try {
    readFileSync(sibling);
    wavPath = sibling;
  } catch {
    wavPath = join(dir, sidecar.audioFile);
  }

  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();

  void runOneTurn({
    inputWavPath: wavPath,
    sessionDir: join(dir, "replay"),
  })
    .then((result) => {
      const expected = normalize(sidecar.expectedTranscript ?? "");
      const actual = normalize(result.finalTranscript);
      const match = expected === actual;
      console.log(JSON.stringify({ match, expected: sidecar.expectedTranscript, actual: result.finalTranscript, agentReply: result.agentReply }, null, 2));
      if (!match) {
        console.error("\nTranscript drifted from the capture. Either the pipeline changed or the fixture is stale.");
        process.exit(1);
      }
      console.log("\nReplay reproduced the captured transcript.");
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

main();
