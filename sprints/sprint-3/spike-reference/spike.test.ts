// SPDX-License-Identifier: MIT

import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SPIKE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HANDOFF_DIR = fileURLToPath(new URL("../../../.handoff/", import.meta.url));

type SuspendBody = {
  phase: string;
  runId: string;
  suspended: boolean;
  suspendPayload?: unknown;
  chunkTypes: string[];
  error?: string;
};

type ResumeBody = {
  phase: string;
  runId: string;
  suspended: boolean;
  text: string;
  chunkTypes: string[];
  error?: string;
};

const tempDirs: string[] = [];
let bundleOutdir = "";
let bundleSizeKb = 0;
let bundleLog = "";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeAll(async () => {
  const outdir = await mkdtemp(join(tmpdir(), "mastra-edge-bundle-"));
  // Keep bundle dir alive for all tests in this file (not in tempDirs).
  const wranglerBin = join(SPIKE_ROOT, "node_modules/.bin/wrangler");
  const { stdout, stderr } = await execFileAsync(
    wranglerBin,
    ["deploy", "--dry-run", "--outdir", outdir],
    { cwd: SPIKE_ROOT, env: process.env },
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
  return unstable_dev(join(SPIKE_ROOT, "src/worker.ts"), {
    config: join(SPIKE_ROOT, "wrangler.toml"),
    local: true,
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    experimental: { disableExperimentalWarning: true },
  });
}

describe("mastra-edge spike", () => {
  it("Q1: bundles @mastra/core + @mastra/cloudflare via wrangler (nodejs_compat)", () => {
    expect(bundleOutdir).toBeTruthy();
    expect(bundleSizeKb).toBeGreaterThan(0);
    expect(bundleLog).not.toMatch(/Could not resolve|unresolved|ERROR/i);
    // eslint-disable-next-line no-console
    console.log(`[Q1] bundle size: ${bundleSizeKb} KB`);
    // eslint-disable-next-line no-console
    console.log(`[Q1] bundle log tail:\n${bundleLog.slice(-2000)}`);
  }, 10_000);

  it("Q2+Q3: boots Mastra in workerd, suspends, resumes across fresh Mastra instance on same SQL", async () => {
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
      // eslint-disable-next-line no-console
      console.log("[Q2/Q3] suspend response:", JSON.stringify(suspendBody, null, 2));

      if ("error" in suspendBody) {
        throw new Error(`suspend failed: ${suspendBody.error}`);
      }

      expect(suspendRes.status).toBe(200);
      expect(suspendBody.phase).toBe("suspend");
      expect(suspendBody.runId).toBeTruthy();
      expect(suspendBody.suspended).toBe(true);
      expect(suspendBody.chunkTypes).toContain("tool-call-suspended");

      const resumeRes = await worker.fetch("http://localhost/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: suspendBody.runId, data: { confirmed: true } }),
      });
      const resumeBody = await resumeRes.json() as ResumeBody | { error: string };
      // eslint-disable-next-line no-console
      console.log("[Q2/Q3] resume response:", JSON.stringify(resumeBody, null, 2));

      if ("error" in resumeBody) {
        throw new Error(`resume failed: ${resumeBody.error}`);
      }

      expect(resumeRes.status).toBe(200);
      expect(resumeBody.phase).toBe("resume");
      expect(resumeBody.suspended).toBe(false);
      expect(resumeBody.text).toContain("Deployed successfully");
      expect(resumeBody.chunkTypes).toContain("finish");

      if (fsHits.length > 0) {
        // eslint-disable-next-line no-console
        console.log("[Q4] fs-related errors:", fsHits);
      }
    } finally {
      console.error = originalConsoleError;
      await worker.stop();
    }
  }, 120_000);
});
