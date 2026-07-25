// SPDX-License-Identifier: MIT

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CliError, EXIT_CODES } from "./exit-codes.js";
import { resolveAgentFactory } from "./agent-resolve.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__");

describe("resolveAgentFactory", () => {
  it("resolves a named export and the factory builds a real session", async () => {
    const resolved = await resolveAgentFactory(`${join(FIXTURES, "good-text-agent.mjs")}#createSession`, HERE);
    expect(resolved.label).toContain("createSession");
    const session = await resolved.factory();
    expect(typeof session.start).toBe("function");
    await session.close();
  });

  it("refuses a module that does not exist, as USAGE", async () => {
    const err = await resolveAgentFactory(join(FIXTURES, "does-not-exist.mjs"), HERE).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("refuses when the requested export is not callable, naming the export it looked for", async () => {
    const err = await resolveAgentFactory(`${join(FIXTURES, "no-callable-export.mjs")}#notAFunction`, HERE).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
    expect((err as CliError).message).toContain("notAFunction");
    expect((err as CliError).message).toContain("(none)"); // neither export in the fixture is callable
  });

  it("refuses an empty --agent spec (no module path) as USAGE", async () => {
    const err = await resolveAgentFactory("#justAnExport", HERE).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("resolves fine but classifies a construction-time throw as CONFIG, not USAGE", async () => {
    const resolved = await resolveAgentFactory(join(FIXTURES, "throwing-agent.mjs"), HERE);
    const err = await Promise.resolve(resolved.factory()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.CONFIG);
    expect((err as CliError).message).toContain("FAKE_AGENT_API_KEY");
  });
});
