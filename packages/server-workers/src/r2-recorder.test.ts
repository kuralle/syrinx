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

function wavChannels(body: Uint8Array | string): number {
  const wav = body as Uint8Array;
  return new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint16(22, true);
}

describe("R2EdgeRecorder", () => {
  it("writes a stereo conversation.wav plus user/assistant stems and manifest", async () => {
    const { bucket, puts } = fakeBucket();
    const rec = new R2EdgeRecorder({ bucket, sessionId: "s1", startedAtMs: 1000, now: () => 1000 });

    rec.onUserAudio("c1", new Uint8Array(640), 16000);
    rec.onAssistantAudio("c1", new Uint8Array(320), 24000);
    await rec.finalize({ sessionId: "s1", closedAtMs: 2000 });

    const keys = puts.map((p) => p.key).sort();
    expect(keys).toEqual([
      "recordings/s1/1000/assistant.wav",
      "recordings/s1/1000/conversation.wav",
      "recordings/s1/1000/manifest.json",
      "recordings/s1/1000/user.wav",
    ]);

    const conversation = puts.find((p) => p.key.endsWith("conversation.wav"))!.body;
    expect(asString((conversation as Uint8Array).subarray(0, 4))).toBe("RIFF");
    expect(wavChannels(conversation)).toBe(2); // stereo: user L / assistant R
    expect(wavChannels(puts.find((p) => p.key.endsWith("user.wav"))!.body)).toBe(1);

    const manifest = JSON.parse(asString(puts.find((p) => p.key.endsWith("manifest.json"))!.body)) as {
      conversation: { channels: number };
    };
    expect(manifest.conversation.channels).toBe(2);
  });

  it("time-aligns the assistant after the user instead of stacking at 0", async () => {
    const { bucket, puts } = fakeBucket();
    let now = 0;
    const rec = new R2EdgeRecorder({ bucket, sessionId: "t", startedAtMs: 0, now: () => now });

    now = 0;
    rec.onUserAudio("c", new Uint8Array(640), 16000); // 20ms of user at t=0
    now = 1000;
    rec.onAssistantAudio("c", new Uint8Array(320), 16000); // assistant starts at t=1000ms
    await rec.finalize({ sessionId: "t", closedAtMs: 1100 });

    const manifest = JSON.parse(asString(puts.find((p) => p.key.endsWith("manifest.json"))!.body)) as {
      conversation: { durationMs: number };
      assistant: { durationMs: number };
    };
    // Assistant anchored at ~1000ms, so both the assistant stem and the merged
    // conversation run ~1010ms — not the ~20ms they'd be if stacked at offset 0.
    expect(manifest.assistant.durationMs).toBe(1010);
    expect(manifest.conversation.durationMs).toBe(1010);
  });

  it("does not write anything when no audio was captured", async () => {
    const { bucket, puts } = fakeBucket();
    const rec = new R2EdgeRecorder({ bucket, sessionId: "empty", startedAtMs: 1 });
    await rec.finalize({ sessionId: "empty", closedAtMs: 2 });
    expect(puts).toHaveLength(0);
  });

  it("flags truncation past the per-stream cap instead of buffering unbounded", async () => {
    const { bucket, puts } = fakeBucket();
    const rec = new R2EdgeRecorder({ bucket, sessionId: "big", startedAtMs: 1, maxBytesPerStream: 1000, now: () => 1 });
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
