// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError, EXIT_CODES } from "./exit-codes.js";
import { assertTranscript, loadFixture, normalizeTranscript } from "./fixture.js";

describe("normalizeTranscript / assertTranscript", () => {
  it("ignores case, punctuation, and extra whitespace", () => {
    expect(normalizeTranscript("Hello,   World!")).toBe("hello world");
    expect(assertTranscript("Hello, World!", "hello   world").match).toBe(true);
  });

  it("flags a real drift", () => {
    const a = assertTranscript("book a flight to paris", "book a flight to london");
    expect(a.match).toBe(false);
    expect(a.expectedTranscript).toBe("book a flight to paris");
    expect(a.actualTranscript).toBe("book a flight to london");
  });
});

describe("loadFixture", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "syrinx-cli-fixture-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, maxRetries: 3, force: true }).catch(() => {});
  });

  it("loads a well-formed sidecar and prefers a sibling captured.wav", async () => {
    const sidecarPath = join(root, "turn.json");
    await writeFile(
      sidecarPath,
      JSON.stringify({
        format: "syrinx.fixture.v1",
        audioFile: "turn.wav",
        audio: { sampleRateHz: 16000, channels: 1, encoding: "pcm_s16le" },
        expectedTranscript: "hi there",
      }),
    );
    await writeFile(join(root, "captured.wav"), Buffer.from([1, 2, 3]));

    const loaded = loadFixture(sidecarPath);
    expect(loaded.sidecar.expectedTranscript).toBe("hi there");
    expect(loaded.wavPath).toBe(join(root, "captured.wav"));
  });

  it("falls back to audioFile when no sibling captured.wav exists", async () => {
    const sidecarPath = join(root, "turn.json");
    await writeFile(
      sidecarPath,
      JSON.stringify({
        format: "syrinx.fixture.v1",
        audioFile: "turn.wav",
        audio: { sampleRateHz: 16000, channels: 1, encoding: "pcm_s16le" },
      }),
    );
    const loaded = loadFixture(sidecarPath);
    expect(loaded.wavPath).toBe(join(root, "turn.wav"));
  });

  it("refuses an unrecognised format", async () => {
    const sidecarPath = join(root, "turn.json");
    await writeFile(
      sidecarPath,
      JSON.stringify({ format: "other.v1", audioFile: "turn.wav", audio: { sampleRateHz: 16000, channels: 1, encoding: "pcm_s16le" } }),
    );
    try {
      loadFixture(sidecarPath);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
    }
  });

  it("refuses a capture config it cannot honestly replay (stereo / non-16kHz)", async () => {
    const sidecarPath = join(root, "turn.json");
    await writeFile(
      sidecarPath,
      JSON.stringify({ format: "syrinx.fixture.v1", audioFile: "turn.wav", audio: { sampleRateHz: 16000, channels: 2, encoding: "pcm_s16le" } }),
    );
    expect(() => loadFixture(sidecarPath)).toThrow(CliError);
  });

  it("refuses malformed JSON", async () => {
    const sidecarPath = join(root, "turn.json");
    await writeFile(sidecarPath, "{not json");
    expect(() => loadFixture(sidecarPath)).toThrow(CliError);
  });

  it("refuses a missing file", () => {
    expect(() => loadFixture(join(root, "nope.json"))).toThrow(CliError);
  });
});
