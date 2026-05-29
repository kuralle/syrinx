// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRecorderPcmSampleRateHz } from "../scripts/serve-telephony-review.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "syrinx-telephony-review-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("telephony review recorder artifacts", () => {
  it("serves assistant WAV artifacts using the recorder manifest sample rate", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = join(dir, "gemini-session");
      await mkdir(sessionDir);
      await writeFile(join(sessionDir, "assistant_audio.pcm"), Buffer.alloc(4800));
      await writeFile(join(sessionDir, "manifest.json"), `${JSON.stringify({
        schemaVersion: 1,
        audio: {
          assistant: {
            sampleRateHz: 24000,
          },
        },
      })}\n`);

      await expect(readRecorderPcmSampleRateHz(dir, "gemini-session/assistant_audio.pcm", "assistant"))
        .resolves.toBe(24000);
    });
  });

  it("refuses to infer assistant WAV sample rate without recorder manifest evidence", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = join(dir, "missing-manifest-session");
      await mkdir(sessionDir);
      await writeFile(join(sessionDir, "assistant_audio.pcm"), Buffer.alloc(3200));

      await expect(readRecorderPcmSampleRateHz(dir, "missing-manifest-session/assistant_audio.pcm", "assistant"))
        .rejects.toThrow("assistant audio sample rate is unknown without recorder manifest");
    });
  });
});
