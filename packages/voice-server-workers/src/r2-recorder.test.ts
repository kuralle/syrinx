// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { R2EdgeRecorder } from "./r2-recorder.js";

interface PutCall {
  key: string;
  body: Uint8Array | string;
}

function fakeBucket() {
  const puts: PutCall[] = [];
  const bucket = {
    async put(key: string, body: Uint8Array | string) {
      puts.push({ key, body });
      return {} as unknown;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

function asString(body: Uint8Array | string): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

describe("R2EdgeRecorder", () => {
  it("writes user/assistant WAV + manifest to R2 on finalize", async () => {
    const { bucket, puts } = fakeBucket();
    const rec = new R2EdgeRecorder({ bucket, sessionId: "s1", startedAtMs: 1000 });

    // 320 samples (640 bytes) of user audio @16k, 160 samples (320 bytes) tts @24k.
    rec.onUserAudio("c1", new Uint8Array(640), 16000);
    rec.onAssistantAudio("c1", new Uint8Array(320), 24000);
    await rec.finalize({ sessionId: "s1", closedAtMs: 2000 });

    const keys = puts.map((p) => p.key).sort();
    expect(keys).toEqual([
      "recordings/s1/1000/assistant.wav",
      "recordings/s1/1000/manifest.json",
      "recordings/s1/1000/user.wav",
    ]);

    const userWav = puts.find((p) => p.key.endsWith("user.wav"))!.body as Uint8Array;
    expect(asString(userWav.subarray(0, 4))).toBe("RIFF");
    expect(asString(userWav.subarray(8, 12))).toBe("WAVE");
    expect(userWav.byteLength).toBe(44 + 640); // header + pcm

    const manifest = JSON.parse(asString(puts.find((p) => p.key.endsWith("manifest.json"))!.body)) as {
      user: { sampleRateHz: number; byteLength: number; durationMs: number };
      assistant: { sampleRateHz: number; byteLength: number };
    };
    expect(manifest.user.sampleRateHz).toBe(16000);
    expect(manifest.user.byteLength).toBe(640);
    expect(manifest.user.durationMs).toBe(20); // 320 samples @16k = 20ms
    expect(manifest.assistant.sampleRateHz).toBe(24000);
  });

  it("does not write anything when no audio was captured", async () => {
    const { bucket, puts } = fakeBucket();
    const rec = new R2EdgeRecorder({ bucket, sessionId: "empty", startedAtMs: 1 });
    await rec.finalize({ sessionId: "empty", closedAtMs: 2 });
    expect(puts).toHaveLength(0);
  });

  it("flags truncation past the per-stream cap instead of buffering unbounded", async () => {
    const { bucket, puts } = fakeBucket();
    const rec = new R2EdgeRecorder({ bucket, sessionId: "big", startedAtMs: 1, maxBytesPerStream: 1000 });
    rec.onUserAudio("c", new Uint8Array(800), 16000);
    rec.onUserAudio("c", new Uint8Array(800), 16000); // would exceed 1000 -> dropped
    await rec.finalize({ sessionId: "big", closedAtMs: 2 });

    const manifest = JSON.parse(asString(puts.find((p) => p.key.endsWith("manifest.json"))!.body)) as {
      user: { byteLength: number; truncated: boolean };
    };
    expect(manifest.user.byteLength).toBe(800);
    expect(manifest.user.truncated).toBe(true);
  });
});
