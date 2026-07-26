// SPDX-License-Identifier: MIT
//
// Orchestrates file emission: builds the file map from a resolved combination,
// then either lists it (--dry-run) or writes it and (unless skipped) installs.

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ResolvedOptions } from "./options.js";
import { buildAgentModule } from "./templates/agent-module.js";
import { buildDevServer } from "./templates/dev-server.js";
import { buildPackageJson } from "./templates/package-json.js";
import { buildEnvExample } from "./templates/env-example.js";
import { buildAgentsMd } from "./templates/agents-md.js";
import { buildTsconfig } from "./templates/tsconfig.js";
import { buildCloudflareWorkerSource, buildWranglerJsonc } from "./templates/cloudflare-worker.js";

export interface ProjectFile {
  readonly relPath: string;
  readonly content: string | Buffer;
}

export function buildFileMap(opts: ResolvedOptions): readonly ProjectFile[] {
  const files: ProjectFile[] = [
    { relPath: "package.json", content: buildPackageJson(opts) },
    { relPath: "tsconfig.json", content: buildTsconfig(opts.runtime) },
    { relPath: ".env.example", content: buildEnvExample(opts) },
    { relPath: "AGENTS.md", content: buildAgentsMd(opts) },
    { relPath: "src/agent.ts", content: buildAgentModule(opts) },
    { relPath: "scripts/dev-server.ts", content: buildDevServer(opts.transport) },
  ];

  if (opts.runtime === "cloudflare") {
    files.push(
      { relPath: "src/index.ts", content: buildCloudflareWorkerSource(opts) },
      { relPath: "wrangler.jsonc", content: buildWranglerJsonc(opts) },
    );
  }

  return files;
}

export async function writeProject(targetDir: string, files: readonly ProjectFile[]): Promise<void> {
  for (const file of files) {
    const abs = join(targetDir, file.relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content);
  }
}

/** Runs `npm install` in targetDir. Errors surface to the caller (never swallowed). */
export function runNpmInstall(targetDir: string): void {
  const result = spawnSync("npm", ["install"], { cwd: targetDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install exited with code ${String(result.status)}`);
}
