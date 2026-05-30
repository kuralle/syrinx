// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readRecorderPcmSampleRateHz,
  telephonyReviewHealthPayload,
} from "../scripts/serve-telephony-review.js";
import {
  readRecorderAssistantSampleRateHz,
  readValidatedRecorderManifest,
} from "../scripts/run-live-university-recorder-coherence.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "syrinx-telephony-review-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("telephony review recorder artifacts", () => {
  it("separates telephony engine output rate from recorder assistant source rate", () => {
    expect(telephonyReviewHealthPayload("gemini", "/tmp/syrinx-review")).toMatchObject({
      inputSampleRateHz: 16000,
      engineOutputSampleRateHz: 16000,
      recorderAssistantSampleRateHz: 24000,
    });
    expect(telephonyReviewHealthPayload("cartesia", "/tmp/syrinx-review")).toMatchObject({
      inputSampleRateHz: 16000,
      engineOutputSampleRateHz: 16000,
      recorderAssistantSampleRateHz: 16000,
    });
  });

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

  it("uses recorder manifest sample rate for live recorder coherence assistant artifacts", () => {
    expect(readRecorderAssistantSampleRateHz({
      audio: {
        user: { byteLength: 0, durationMs: 0, chunks: 0 },
        assistant: { sampleRateHz: 24000, byteLength: 4800, durationMs: 100, chunks: 1, truncations: 0 },
      },
      events: { packets: 1 },
    })).toBe(24000);
  });

  it("validates live recorder manifests before they drive review artifacts", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify({
        schemaVersion: 1,
        audio: {
          assistant: {
            sampleRateHz: 24000,
          },
        },
      })}\n`);

      expect(() => readValidatedRecorderManifest(manifestPath))
        .toThrow("Invalid recorder manifest");
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
