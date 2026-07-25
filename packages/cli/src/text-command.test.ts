// SPDX-License-Identifier: MIT

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CliError, EXIT_CODES } from "./exit-codes.js";
import { runTextCommand } from "./text-command.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__");

describe("runTextCommand", () => {
  it("resolves --agent and drives a real turn end to end, with no live provider", async () => {
    const result = await runTextCommand({ message: "hi", agentSpec: `${join(FIXTURES, "good-text-agent.mjs")}#createSession` });
    expect(result.reply).toBe("Hello from the fake agent.");
    expect(result.agent).toContain("createSession");
  });

  it("refuses an unresolvable --agent as USAGE", async () => {
    const err = await runTextCommand({ message: "hi", agentSpec: join(FIXTURES, "does-not-exist.mjs") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("reports CONFIG when the agent module throws constructing a session", async () => {
    const err = await runTextCommand({ message: "hi", agentSpec: join(FIXTURES, "throwing-agent.mjs") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.CONFIG);
  });
});
