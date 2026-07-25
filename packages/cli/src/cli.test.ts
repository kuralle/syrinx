// SPDX-License-Identifier: MIT

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { main, type CliIO } from "./cli.js";
import { EXIT_CODES } from "./exit-codes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__");

function captureIO(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) }, stdout, stderr };
}

describe("main — global flags", () => {
  it("--help prints usage to stdout and exits SUCCESS", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["--help"], io);
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout.join("\n")).toContain("USAGE");
    expect(stdout.join("\n")).toContain("EXIT CODES");
  });

  it("no arguments prints usage (same as --help)", async () => {
    const { io, stdout } = captureIO();
    const code = await main([], io);
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout.join("\n")).toContain("USAGE");
  });

  it("--version prints just the version and exits SUCCESS", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["--version"], io);
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("main — usage errors", () => {
  it("an unknown command exits USAGE and, with --json, stays parseable on stdout", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["frobnicate", "--json"], io);
    expect(code).toBe(EXIT_CODES.USAGE);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]!) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("USAGE");
  });

  it("without --json, an unknown command prints nothing to stdout and the error to stderr", async () => {
    const { io, stdout, stderr } = captureIO();
    const code = await main(["frobnicate"], io);
    expect(code).toBe(EXIT_CODES.USAGE);
    expect(stdout).toHaveLength(0);
    expect(stderr.join("\n")).toContain("frobnicate");
  });

  it("console/chat/listen are explicitly rejected — this CLI is not a console", async () => {
    for (const verb of ["console", "chat", "listen"]) {
      const { io } = captureIO();
      const code = await main([verb], io);
      expect(code).toBe(EXIT_CODES.USAGE);
    }
  });

  it("turn without --in exits USAGE", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["turn", "--agent", "whatever#x", "--json"], io);
    expect(code).toBe(EXIT_CODES.USAGE);
    const parsed = JSON.parse(stdout[0]!) as { error: { code: string } };
    expect(parsed.error.code).toBe("USAGE");
  });

  it("turn without --agent exits USAGE — the CLI brings no provider of its own", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["turn", "--in", "/tmp/whatever.wav", "--json"], io);
    expect(code).toBe(EXIT_CODES.USAGE);
    const parsed = JSON.parse(stdout[0]!) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("USAGE");
    expect(parsed.error.message).toContain("--agent");
  });

  it("turn --agent pointing at a nonexistent module fails USAGE with a message naming what could not be resolved — no stack trace, no silent fallback", async () => {
    const { io, stdout, stderr } = captureIO();
    const code = await main(["turn", "--in", "/tmp/whatever.wav", "--agent", "./does/not/exist.ts#nope", "--json"], io);
    expect(code).toBe(EXIT_CODES.USAGE);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]!) as { ok: boolean; error: { code: string; message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("USAGE");
    expect(parsed.error.message).toContain("does/not/exist.ts");
    expect(stderr.join("\n")).not.toContain("at "); // no stack trace leaked for a documented failure class
  });

  it("text without a message exits USAGE", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["text", "--agent", "whatever#x", "--json"], io);
    expect(code).toBe(EXIT_CODES.USAGE);
    const parsed = JSON.parse(stdout[0]!) as { error: { code: string } };
    expect(parsed.error.code).toBe("USAGE");
  });

  it("text without --agent exits USAGE", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["text", "hi", "--json"], io);
    expect(code).toBe(EXIT_CODES.USAGE);
    const parsed = JSON.parse(stdout[0]!) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("USAGE");
    expect(parsed.error.message).toContain("--agent");
  });

  it("an unrecognised flag exits USAGE rather than throwing past the CLI", async () => {
    const { io } = captureIO();
    const code = await main(["doctor", "--not-a-real-flag"], io);
    expect(code).toBe(EXIT_CODES.USAGE);
  });
});

describe("main — end to end through --agent, no live provider", () => {
  it("text --agent <fixture> resolves the caller's own module and drives a real turn", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["text", "hi", "--agent", `${join(FIXTURES, "good-text-agent.mjs")}#createSession`, "--json"], io);
    expect(code).toBe(EXIT_CODES.SUCCESS);
    const parsed = JSON.parse(stdout[0]!) as { ok: boolean; reply: string; agent: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.reply).toBe("Hello from the fake agent.");
    expect(parsed.agent).toContain("createSession");
  });
});

describe("main — doctor", () => {
  it("doctor --json emits one parseable object and always exits SUCCESS", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["doctor", "--json"], io);
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]!) as { ok: boolean; verb: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.verb).toBe("doctor");
  });

  it("doctor without --json prints a human summary, not JSON", async () => {
    const { io, stdout } = captureIO();
    const code = await main(["doctor"], io);
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(() => JSON.parse(stdout[0]!)).toThrow();
  });
});
