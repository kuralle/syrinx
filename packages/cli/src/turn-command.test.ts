// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError, EXIT_CODES } from "./exit-codes.js";
import { runTurnCommand } from "./turn-command.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__");
const UNUSED_AGENT_SPEC = "unresolved-if-reached#nope"; // fixture validation must reject before this is ever imported

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "syrinx-cli-turn-cmd-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, maxRetries: 3, force: true }).catch(() => {});
});

describe("runTurnCommand — fixture validation runs before agent resolution", () => {
  it("refuses an unsupported fixture format as USAGE, without ever resolving --agent", async () => {
    const p = join(root, "bad-format.json");
    await writeFile(
      p,
      JSON.stringify({ format: "not.the.right.format", audioFile: "captured.wav", audio: { sampleRateHz: 16000, channels: 1, encoding: "pcm_s16le" } }),
    );
    const err = await runTurnCommand({ inputPath: p, agentSpec: UNUSED_AGENT_SPEC }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
    expect((err as CliError).message).toContain("unsupported fixture format"); // proves the FIXTURE check fired, not agent resolution
  });

  it("refuses a capture-config mismatch as USAGE", async () => {
    const p = join(root, "bad-rate.json");
    await writeFile(
      p,
      JSON.stringify({
        format: "syrinx.fixture.v1",
        audioFile: "captured.wav",
        audio: { sampleRateHz: 24000, channels: 1, encoding: "pcm_s16le" },
        expectedTranscript: "hello there",
      }),
    );
    const err = await runTurnCommand({ inputPath: p, agentSpec: UNUSED_AGENT_SPEC }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
    expect((err as CliError).message).toContain("mono 16 kHz");
  });

  it("refuses a missing fixture file as USAGE", async () => {
    const err = await runTurnCommand({ inputPath: join(root, "does-not-exist.json"), agentSpec: UNUSED_AGENT_SPEC }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
    expect((err as CliError).message).toContain("fixture not found");
  });
});

describe("runTurnCommand — --agent resolution", () => {
  it("refuses an unresolvable --agent module as USAGE once the fixture itself is fine", async () => {
    const wavPath = join(root, "input.wav");
    await writeFile(wavPath, Buffer.from([]));
    const err = await runTurnCommand({ inputPath: wavPath, agentSpec: join(FIXTURES, "does-not-exist.mjs") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("reports CONFIG when the --agent module resolves but throws constructing a session", async () => {
    const wavPath = join(root, "input.wav");
    await writeFile(wavPath, Buffer.from([]));
    const err = await runTurnCommand({ inputPath: wavPath, agentSpec: join(FIXTURES, "throwing-agent.mjs") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.CONFIG);
    expect((err as CliError).message).toContain("FAKE_AGENT_API_KEY");
  });
});
