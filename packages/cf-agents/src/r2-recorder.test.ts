// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { R2EdgeRecorder } from "./r2-recorder.js";

interface PutCall {
  key: string;
  body: Uint8Array | string;
}

interface MpuRec {
  key: string;
  parts: { partNumber: number; size: number }[];
  first?: Uint8Array; // retained bytes of part 1 (the header-bearing part)
  completed: boolean;
}

function fakeBucket() {
  const puts: PutCall[] = [];
  const mpus = new Map<string, MpuRec>();
  let seq = 0;

  function handle(uploadId: string) {
    const rec = mpus.get(uploadId)!;
    return {
      key: rec.key,
      uploadId,
      async uploadPart(partNumber: number, value: Uint8Array) {
        rec.parts.push({ partNumber, size: value.byteLength });
        if (partNumber === 1) rec.first = value.slice();
        return { partNumber, etag: `etag-${partNumber}` };
      },
      async complete(_parts: unknown) {
        rec.completed = true;
        return { key: rec.key } as unknown;
      },
      async abort() {
        /* no-op */
      },
    };
  }

  const bucket = {
    async put(key: string, body: Uint8Array | string) {
      puts.push({ key, body: typeof body === "string" ? body : body.slice() });
      return {} as unknown;
    },
    async createMultipartUpload(key: string) {
      const uploadId = `u${++seq}`;
      mpus.set(uploadId, { key, parts: [], completed: false });
      return handle(uploadId);
    },
    resumeMultipartUpload(_key: string, uploadId: string) {
      return handle(uploadId);
    },
  } as unknown as R2Bucket;

  return { bucket, puts, mpus };
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
      conversation: { channels: number; omitted: boolean };
    };
    expect(manifest.conversation.channels).toBe(2);
    expect(manifest.conversation.omitted).toBe(false);
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

  it("streams a long, mostly-silent call to R2 in bounded parts instead of one giant buffer", async () => {
    const { bucket, puts, mpus } = fakeBucket();
    let now = 0;
    const rec = new R2EdgeRecorder({ bucket, sessionId: "long", startedAtMs: 0, now: () => now });

    // A 20-minute call: a blip of audio, a 20-minute wall-clock gap, then another blip.
    // The old recorder would gap-fill the full ~38 MB wall-clock length in one allocation
    // at finalize (OOMing the 128 MB DO). The stream must instead flush it as R2 parts.
    now = 0;
    rec.onUserAudio("c", new Uint8Array(320), 16000);
    now = 20 * 60 * 1000; // +20 min
    rec.onUserAudio("c", new Uint8Array(320), 16000);
    await rec.finalize({ sessionId: "long", closedAtMs: now + 100 });

    const expectedDataBytes = 20 * 60 * 16000 * 2 + 320; // wall-clock timeline + the final blip

    // (1) The user stem streamed out incrementally: multiple parts, not one buffer.
    const userMpu = [...mpus.values()].find((m) => m.key === "recordings/long/0/user.wav")!;
    expect(userMpu).toBeDefined();
    expect(userMpu.parts.length).toBeGreaterThan(1);
    expect(userMpu.completed).toBe(true);
    // Every part except the last carries at least R2's 5 MiB minimum (part 1 also holds the header).
    const byNumber = [...userMpu.parts].sort((a, b) => a.partNumber - b.partNumber);
    for (const p of byNumber.slice(0, -1)) expect(p.size).toBeGreaterThanOrEqual(5 * 1024 * 1024);

    // (2) The stem decodes to the right duration: part 1's WAV header declares the full
    // data length, and the parts sum to header(44) + that length.
    const header = new DataView(userMpu.first!.buffer, userMpu.first!.byteOffset, userMpu.first!.byteLength);
    expect(header.getUint32(40, true)).toBe(expectedDataBytes); // WAV data-chunk size field
    const uploaded = userMpu.parts.reduce((n, p) => n + p.size, 0);
    expect(uploaded).toBe(44 + expectedDataBytes);

    // (3) finalize still writes the manifest; the stem length/duration match, and the
    // stereo mix is flagged omitted (best-effort) once a stem has streamed out.
    const manifest = JSON.parse(asString(puts.find((p) => p.key.endsWith("manifest.json"))!.body)) as {
      user: { byteLength: number; durationMs: number; truncated: boolean };
      conversation: { omitted: boolean };
    };
    expect(manifest.user.byteLength).toBe(expectedDataBytes);
    expect(manifest.user.durationMs).toBe(Math.round((expectedDataBytes / 2 / 16000) * 1000));
    expect(manifest.user.truncated).toBe(false);
    expect(manifest.conversation.omitted).toBe(true);
    expect(puts.some((p) => p.key.endsWith("conversation.wav"))).toBe(false);
  });
});
