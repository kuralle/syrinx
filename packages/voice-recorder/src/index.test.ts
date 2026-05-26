// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PipelineBusImpl, Route } from "@asyncdot/voice";
import type { RecordAssistantAudioPacket, RecordUserAudioPacket, VoicePacket } from "@asyncdot/voice";
import { VoiceSessionRecorder } from "./index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "syrinx-recorder-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function packet(kind: string): VoicePacket {
  return {
    kind,
    contextId: "turn-1",
    timestampMs: Date.now(),
  };
}

describe("VoiceSessionRecorder", () => {
  it("records bus packets as JSONL without embedding raw audio bytes", async () => {
    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, { output_dir: dir });

      bus.push(Route.Main, {
        kind: "record.user_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array([1, 2, 3, 4]),
      } satisfies RecordUserAudioPacket);
      bus.push(Route.Critical, packet("interrupt.tts"));

      await recorder.close();

      const events = await readFile(join(dir, "events.jsonl"), "utf8");
      const lines = events.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);

      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        route: "Main",
        kind: "record.user_audio",
        context_id: "turn-1",
        packet: {
          audio: {
            type: "Uint8Array",
            byteLength: 4,
          },
        },
      });
      expect(lines[1]).toMatchObject({
        route: "Critical",
        kind: "interrupt.tts",
      });
    });
  });

  it("flushes user and assistant audio files on close", async () => {
    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, { output_dir: dir });
      const start = bus.start();

      bus.push(Route.Main, {
        kind: "record.user_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array([1, 2, 3, 4]),
      } satisfies RecordUserAudioPacket);
      bus.push(Route.Main, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array([5, 6, 7]),
        truncate: false,
      } satisfies RecordAssistantAudioPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));
      bus.stop();
      await start;
      await recorder.close();

      await expect(readFile(join(dir, "user_audio.pcm"))).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
      await expect(readFile(join(dir, "assistant_audio.pcm"))).resolves.toEqual(Buffer.from([5, 6, 7]));
      await expect(stat(join(dir, "events.jsonl"))).resolves.toMatchObject({ size: expect.any(Number) });
    });
  });
});
