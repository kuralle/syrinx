// SPDX-License-Identifier: MIT

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__");

describe("runDoctor", () => {
  it("never echoes key values, only presence", async () => {
    const report = await runDoctor({
      cwd: HERE,
      env: { OPENAI_API_KEY: "sk-super-secret-value", DEEPGRAM_API_KEY: undefined },
    });
    expect(JSON.stringify(report)).not.toContain("sk-super-secret-value");
    expect(report.wellKnownProviderKeys.OPENAI_API_KEY).toBe(true);
    expect(report.wellKnownProviderKeys.DEEPGRAM_API_KEY).toBe(false);
  });

  it("treats a blank/whitespace-only key as absent", async () => {
    const report = await runDoctor({ cwd: HERE, env: { OPENAI_API_KEY: "   " } });
    expect(report.wellKnownProviderKeys.OPENAI_API_KEY).toBe(false);
  });

  it("reports the installed @kuralle-syrinx/core version from this workspace", async () => {
    const report = await runDoctor({ cwd: HERE, env: {} });
    expect(report.core.resolved).toBe(true);
    expect(report.core.majorMismatch).toBe(false);
  });

  it("without --agent, reports no fixed provider requirement — just informational keys", async () => {
    const report = await runDoctor({ cwd: HERE, env: {} });
    expect(report.agent).toBeNull();
    expect(report.summary).not.toMatch(/deepgram|cartesia|openai/i);
  });

  it("with --agent, resolves and reports the specific agent instead of a hardcoded set", async () => {
    const ok = await runDoctor({ cwd: HERE, env: {}, agentSpec: `${join(FIXTURES, "good-text-agent.mjs")}#createSession` });
    expect(ok.agent?.resolved).toBe(true);
    expect(ok.agent?.label).toContain("createSession");

    const bad = await runDoctor({ cwd: HERE, env: {}, agentSpec: join(FIXTURES, "does-not-exist.mjs") });
    expect(bad.agent?.resolved).toBe(false);
    expect(bad.agent?.error).toBeTruthy();
  });
});
