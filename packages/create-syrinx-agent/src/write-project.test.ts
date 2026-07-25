// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveOptions } from "./options.js";
import { CliError } from "./exit-codes.js";
import { buildFileMap, writeProject } from "./write-project.js";

describe("buildFileMap — the cascade slice (deepgram/aisdk/cartesia/browser)", () => {
  const opts = resolveOptions({ stt: "deepgram", reasoner: "aisdk", tts: "cartesia", transport: "browser" }, ["x"]);
  const files = buildFileMap(opts);

  it("emits exactly the node-runtime file set — no Cloudflare artifacts", () => {
    expect(files.map((f) => f.relPath).sort()).toEqual([
      ".env.example",
      "AGENTS.md",
      "package.json",
      "scripts/dev-server.ts",
      "src/agent.ts",
      "test/fixtures/smoke.wav",
      "tsconfig.json",
    ]);
  });

  it("package.json depends on exactly the chosen providers, not the whole matrix", () => {
    const pkgFile = files.find((f) => f.relPath === "package.json");
    const pkg = JSON.parse(pkgFile?.content as string) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      [
        "@ai-sdk/openai",
        "@kuralle-syrinx/aisdk",
        "@kuralle-syrinx/cartesia",
        "@kuralle-syrinx/cli",
        "@kuralle-syrinx/core",
        "@kuralle-syrinx/deepgram",
        "@kuralle-syrinx/server-websocket",
        "ai",
        "ws",
      ].sort(),
    );
    // Not present: any provider from a stage that wasn't chosen.
    expect(pkg.dependencies).not.toHaveProperty("@kuralle-syrinx/elevenlabs");
    expect(pkg.dependencies).not.toHaveProperty("@kuralle-syrinx/mastra");
  });

  it(".env.example names exactly the required keys for this combination", () => {
    const envFile = files.find((f) => f.relPath === ".env.example");
    const content = envFile?.content as string;
    expect(content).toContain("DEEPGRAM_API_KEY=");
    expect(content).toContain("CARTESIA_API_KEY=");
    expect(content).toContain("CARTESIA_VOICE_ID=");
    expect(content).toContain("OPENAI_API_KEY=");
    expect(content).not.toContain("ELEVENLABS_API_KEY");
  });

  it("src/agent.ts wires the chosen stage plugins with provider_stt endpointing", () => {
    const agentFile = files.find((f) => f.relPath === "src/agent.ts");
    const content = agentFile?.content as string;
    expect(content).toContain("DeepgramSTTPlugin");
    expect(content).toContain("CartesiaTTSPlugin");
    expect(content).toContain("fromStreamText");
    expect(content).toContain('endpointingOwner: "provider_stt"');
  });

  it("AGENTS.md states plainly what this generator's checks cannot verify", () => {
    const agentsMd = files.find((f) => f.relPath === "AGENTS.md");
    const content = agentsMd?.content as string;
    expect(content).toMatch(/CANNOT verify/);
    expect(content).toMatch(/barge-in/);
    expect(content).toMatch(/tsx/);
  });
});

describe("buildFileMap — --endpointing sets smart_turn ownership", () => {
  it("switches endpointingOwner and registers the eos plugin", () => {
    const opts = resolveOptions(
      { stt: "deepgram", reasoner: "aisdk", tts: "cartesia", transport: "browser", endpointing: "pipecat-smart-turn" },
      ["x"],
    );
    const files = buildFileMap(opts);
    const content = files.find((f) => f.relPath === "src/agent.ts")?.content as string;
    expect(content).toContain('endpointingOwner: "smart_turn"');
    expect(content).toContain("PipecatEOSPlugin");
  });
});

describe("buildFileMap — realtime (speech-to-speech) mode", () => {
  it("emits RealtimeBridge wiring, not STT/TTS stages", () => {
    const opts = resolveOptions({ realtime: "grok" }, ["x"]);
    const files = buildFileMap(opts);
    const content = files.find((f) => f.relPath === "src/agent.ts")?.content as string;
    expect(content).toContain("RealtimeBridge");
    expect(content).toContain("fromGrokRealtime");
    expect(content).toContain('endpointingOwner: "timer"');
  });
});

describe("buildFileMap — --runtime cloudflare", () => {
  it("additionally emits src/index.ts and wrangler.jsonc", () => {
    const opts = resolveOptions(
      { stt: "deepgram", reasoner: "aisdk", tts: "cartesia", transport: "browser", runtime: "cloudflare" },
      ["x"],
    );
    const files = buildFileMap(opts);
    const relPaths = files.map((f) => f.relPath);
    expect(relPaths).toContain("src/index.ts");
    expect(relPaths).toContain("wrangler.jsonc");
    const worker = files.find((f) => f.relPath === "src/index.ts")?.content as string;
    expect(worker).toContain("withVoice");
    expect(worker).toContain('transport: "edge"');
  });

  it("refuses --runtime cloudflare --transport smartpbx (no such binding in cf-agents)", () => {
    const opts = resolveOptions(
      { stt: "deepgram", reasoner: "aisdk", tts: "cartesia", transport: "smartpbx", runtime: "cloudflare" },
      ["x"],
    );
    expect(() => buildFileMap(opts)).toThrow(CliError);
    expect(() => buildFileMap(opts)).toThrow(/no smartpbx transport binding/);
  });
});

describe("buildFileMap — not-yet-implemented providers refuse cleanly", () => {
  it("--reasoner kuralle", () => {
    const opts = resolveOptions({ stt: "deepgram", reasoner: "kuralle", tts: "cartesia", transport: "browser" }, ["x"]);
    expect(() => buildFileMap(opts)).toThrow(/--reasoner kuralle is not yet implemented/);
  });

  it("--endpointing vap", () => {
    const opts = resolveOptions(
      { stt: "deepgram", reasoner: "aisdk", tts: "cartesia", transport: "browser", endpointing: "vap" },
      ["x"],
    );
    expect(() => buildFileMap(opts)).toThrow(/--endpointing vap is not yet implemented/);
  });
});

describe("writeProject", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "create-syrinx-agent-write-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, maxRetries: 3, force: true }).catch(() => {});
  });

  it("writes every file, including a binary fixture, to the target directory", async () => {
    const opts = resolveOptions({ stt: "deepgram", reasoner: "aisdk", tts: "cartesia", transport: "browser" }, ["x"]);
    const files = buildFileMap(opts);
    const targetDir = join(root, "generated");

    await writeProject(targetDir, files);

    const pkgRaw = await readFile(join(targetDir, "package.json"), "utf8");
    expect(JSON.parse(pkgRaw)).toHaveProperty("name");
    const wav = await readFile(join(targetDir, "test/fixtures/smoke.wav"));
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });
});
