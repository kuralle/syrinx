// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const mastraEdgeEnabled = process.env["SYRINX_MASTRA_EDGE_TEST"] === "1";

type SuspendBody = {
  phase: string;
  contextId: string;
  runId: string | null;
  suspended: boolean;
  prompt: string | null;
  pointer: { runId: string } | null;
  mastraTables: string[];
  packetKinds: string[];
  error?: string;
};

type ResumeBody = {
  phase: string;
  contextId: string;
  suspended: boolean;
  text: string;
  pointer: { runId: string } | null;
  mastraTables: string[];
  packetKinds: string[];
  error?: string;
};

const tempDirs: string[] = [];
let bundleOutdir = "";
let bundleSizeKb = 0;
let bundleLog = "";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("voice-server-workers-mastra default suite", () => {
  it("gates workerd two-turn test behind SYRINX_MASTRA_EDGE_TEST", () => {
    expect(mastraEdgeEnabled || process.env["SYRINX_MASTRA_EDGE_TEST"] !== "1").toBe(true);
  });
});

describe.skipIf(!mastraEdgeEnabled)("mastra edge suspend/resume", () => {
  beforeAll(async () => {
    const outdir = await mkdtemp(join(tmpdir(), "mastra-edge-bundle-"));
    const wranglerBin = join(PACKAGE_ROOT, "node_modules/.bin/wrangler");
    const { stdout, stderr } = await execFileAsync(
      wranglerBin,
      ["deploy", "--dry-run", "--outdir", outdir],
      { cwd: PACKAGE_ROOT, env: process.env },
    );
    bundleLog = `${stdout}\n${stderr}`;
    const workerPath = join(outdir, "worker.js");
    if (!existsSync(workerPath)) {
      throw new Error(`wrangler bundle missing worker.js\n${bundleLog}`);
    }
    bundleOutdir = outdir;
    const bundleStat = await stat(workerPath);
    bundleSizeKb = Math.round(bundleStat.size / 1024);
  }, 120_000);

  async function startDevWorker(): Promise<Unstable_DevWorker> {
    return unstable_dev(join(PACKAGE_ROOT, "src/worker.ts"), {
      config: join(PACKAGE_ROOT, "wrangler.toml"),
      local: true,
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      experimental: { disableExperimentalWarning: true },
    });
  }

  it("bundles @mastra/core + @mastra/cloudflare via wrangler (nodejs_compat)", () => {
    expect(bundleOutdir).toBeTruthy();
    expect(bundleSizeKb).toBeGreaterThan(0);
    expect(bundleLog).not.toMatch(/Could not resolve|unresolved|ERROR/i);
  }, 10_000);

  it("suspend → fresh DO/same SQL → resume via ReasoningBridge + pointer RunStore", async () => {
    const worker = await startDevWorker();
    const fsHits: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (/ENOENT|readFileSync|existsSync|fs\./i.test(line)) fsHits.push(line);
      originalConsoleError(...args);
    };

    try {
      const health = await worker.fetch("http://localhost/health");
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("ok");

      const suspendRes = await worker.fetch("http://localhost/suspend");
      const suspendBody = await suspendRes.json() as SuspendBody | { error: string };
      if ("error" in suspendBody) {
        throw new Error(`suspend failed: ${suspendBody.error}`);
      }

      expect(suspendRes.status).toBe(200);
      expect(suspendBody.phase).toBe("suspend");
      expect(suspendBody.suspended).toBe(true);
      expect(suspendBody.runId).toBeTruthy();
      expect(suspendBody.pointer).toEqual({ runId: suspendBody.runId });
      expect(suspendBody.packetKinds).toContain("reasoning.suspended");
      expect(suspendBody.packetKinds).toContain("llm.done");
      expect(suspendBody.mastraTables.some((name) => name.includes("mastra") || name.includes("workflow"))).toBe(true);

      const resumeRes = await worker.fetch("http://localhost/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: "yes" }),
      });
      const resumeBody = await resumeRes.json() as ResumeBody | { error: string };
      if ("error" in resumeBody) {
        throw new Error(`resume failed: ${resumeBody.error}`);
      }

      expect(resumeRes.status).toBe(200);
      expect(resumeBody.phase).toBe("resume");
      expect(resumeBody.suspended).toBe(false);
      expect(resumeBody.text).toContain("Deployed successfully");
      expect(resumeBody.packetKinds).toContain("llm.done");
      expect(resumeBody.pointer).toBeNull();

      if (fsHits.length > 0) {
        // eslint-disable-next-line no-console
        console.log("[fs hits]", fsHits);
      }
    } finally {
      console.error = originalConsoleError;
      await worker.stop();
    }
  }, 120_000);
});
