// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineBusImpl, Route } from "@asyncdot/voice";
import type { RecordAssistantAudioPacket, RecordUserAudioPacket, VoicePacket } from "@asyncdot/voice";
import {
  VoiceSessionRecorder,
  validateVoiceSessionRecorderManifest,
  type VoiceSessionRecorderManifest,
} from "./index.js";

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
  afterEach(() => {
    vi.useRealTimers();
  });

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
        audio: new Uint8Array([5, 6, 7, 8]),
        sampleRateHz: 24000,
        truncate: false,
      } satisfies RecordAssistantAudioPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));
      bus.stop();
      await start;
      await recorder.close();

      await expect(readFile(join(dir, "user_audio.pcm"))).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
      await expect(readFile(join(dir, "assistant_audio.pcm"))).resolves.toEqual(Buffer.from([5, 6, 7, 8]));
      await expect(stat(join(dir, "events.jsonl"))).resolves.toMatchObject({ size: expect.any(Number) });
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Record<string, any>;
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        files: {
          eventsPath: join(dir, "events.jsonl"),
          userAudioPath: join(dir, "user_audio.pcm"),
          assistantAudioPath: join(dir, "assistant_audio.pcm"),
          manifestPath: join(dir, "manifest.json"),
        },
        audio: {
          user: {
            sampleRateHz: 16000,
            encoding: "pcm_s16le",
            channels: 1,
            byteLength: 4,
            chunks: 1,
          },
          assistant: {
            sampleRateHz: 24000,
            encoding: "pcm_s16le",
            channels: 1,
            byteLength: 4,
            chunks: 1,
            truncations: 0,
          },
        },
        events: {
          packets: 2,
          byteLength: expect.any(Number),
        },
      });
    });
  });

  it("rejects odd-byte PCM16 audio before writing misleading recorder artifacts", async () => {
    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, { output_dir: dir });

      bus.push(Route.Main, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array([1, 2, 3]),
        sampleRateHz: 16000,
        truncate: false,
      } satisfies RecordAssistantAudioPacket);

      await expect(recorder.close()).rejects.toThrow("record.assistant_audio audio must contain an even number of PCM16 bytes");
    });
  });

  it("rejects assistant audio without source sample-rate metadata", async () => {
    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, { output_dir: dir });

      bus.push(Route.Main, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array([1, 2, 3, 4]),
        truncate: false,
      } as RecordAssistantAudioPacket);

      await expect(recorder.close()).rejects.toThrow("record.assistant_audio sampleRateHz must be a positive integer");
    });
  });

  it("uses assistant recording sample-rate metadata for manifest duration", async () => {
    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, { output_dir: dir });
      const start = bus.start();

      bus.push(Route.Main, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(3200),
        sampleRateHz: 16000,
        truncate: false,
      } satisfies RecordAssistantAudioPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));
      bus.stop();
      await start;
      await recorder.close();

      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Record<string, any>;
      expect(manifest.audio.assistant).toMatchObject({
        sampleRateHz: 16000,
        byteLength: 3200,
        durationMs: 100,
        chunks: 1,
      });
    });
  });

  it("rejects mixed assistant sample rates inside one recorder session", async () => {
    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, { output_dir: dir });

      bus.push(Route.Main, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(320),
        sampleRateHz: 16000,
        truncate: false,
      } satisfies RecordAssistantAudioPacket);
      bus.push(Route.Main, {
        kind: "record.assistant_audio",
        contextId: "turn-2",
        timestampMs: Date.now(),
        audio: new Uint8Array(480),
        sampleRateHz: 24000,
        truncate: false,
      } satisfies RecordAssistantAudioPacket);

      await expect(recorder.close()).rejects.toThrow(
        "record.assistant_audio sampleRateHz changed within recorder session: 16000 -> 24000",
      );
    });
  });

  it("truncates queued assistant audio at the wall-clock playback position", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, {
        output_dir: dir,
        assistant_sample_rate_hz: 16000,
      });
      const start = bus.start();

      for (const value of [0xa1, 0xa2, 0xa3]) {
        bus.push(Route.Main, {
          kind: "record.assistant_audio",
          contextId: "turn-1",
          timestampMs: Date.now(),
          audio: new Uint8Array(320).fill(value),
          sampleRateHz: 16000,
          truncate: false,
        } satisfies RecordAssistantAudioPacket);
      }
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      vi.setSystemTime(10);
      bus.push(Route.Critical, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(0),
        truncate: true,
      } satisfies RecordAssistantAudioPacket);
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      bus.stop();
      await start;
      const closePromise = recorder.close();
      await vi.runOnlyPendingTimersAsync();
      await closePromise;

      await expect(readFile(join(dir, "assistant_audio.pcm"))).resolves.toEqual(Buffer.alloc(320, 0xa1));
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Record<string, any>;
      expect(manifest.audio.assistant).toMatchObject({
        sampleRateHz: 16000,
        byteLength: 320,
        durationMs: 10,
        chunks: 1,
        truncations: 1,
      });
    });
  });

  it("retains terminal playback truncation when main dispatch is blocked during shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      let releaseMain: () => void = () => undefined;
      let notifyMainBlocked: () => void = () => undefined;
      const mainReleased = new Promise<void>((resolve) => {
        releaseMain = resolve;
      });
      const mainBlocked = new Promise<void>((resolve) => {
        notifyMainBlocked = resolve;
      });
      bus.on("record.assistant_audio", async (pkt) => {
        if (!(pkt as RecordAssistantAudioPacket).truncate) {
          notifyMainBlocked();
          await mainReleased;
        }
      });

      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, {
        output_dir: dir,
        assistant_sample_rate_hz: 16000,
      });
      const start = bus.start();

      for (const value of [0xa1, 0xa2, 0xa3]) {
        bus.push(Route.Main, {
          kind: "record.assistant_audio",
          contextId: "turn-1",
          timestampMs: Date.now(),
          audio: new Uint8Array(320).fill(value),
          sampleRateHz: 16000,
          truncate: false,
        } satisfies RecordAssistantAudioPacket);
      }
      await mainBlocked;

      vi.setSystemTime(10);
      bus.push(Route.Critical, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(0),
        truncate: true,
      } satisfies RecordAssistantAudioPacket);
      await Promise.resolve();

      const closePromise = recorder.close();
      await vi.runOnlyPendingTimersAsync();
      await closePromise;
      releaseMain();
      bus.stop();
      await start;

      await expect(readFile(join(dir, "assistant_audio.pcm"))).resolves.toEqual(Buffer.alloc(320, 0xa1));
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Record<string, any>;
      expect(manifest.audio.assistant).toMatchObject({
        byteLength: 320,
        durationMs: 10,
        truncations: 1,
      });
    });
  });

  it("validates recorder manifest duration and path evidence", () => {
    const manifest = makeRecorderManifest();

    expect(validateVoiceSessionRecorderManifest(manifest)).toStrictEqual([]);

    expect(validateVoiceSessionRecorderManifest({
      ...manifest,
      audio: {
        ...manifest.audio,
        assistant: {
          ...manifest.audio.assistant,
          durationMs: 1,
        },
      },
    })).toContain("audio.assistant.durationMs 1 did not match 100 from byte count/sample rate");

    expect(validateVoiceSessionRecorderManifest({
      ...manifest,
      audio: {
        ...manifest.audio,
        user: {
          ...manifest.audio.user,
          path: "/tmp/other-user-audio.pcm",
        },
      },
    })).toContain("audio.user.path must match files.userAudioPath");
  });

  it("rejects recorder manifests with invalid PCM byte accounting", () => {
    const manifest = makeRecorderManifest();

    expect(validateVoiceSessionRecorderManifest({
      ...manifest,
      audio: {
        ...manifest.audio,
        user: {
          ...manifest.audio.user,
          byteLength: 3,
          durationMs: 0,
        },
      },
    })).toContain("audio.user.byteLength must contain an even number of PCM16 bytes");
  });

  it("reports malformed recorder manifests without throwing", () => {
    expect(validateVoiceSessionRecorderManifest(null)).toStrictEqual(["manifest must be an object"]);
    expect(validateVoiceSessionRecorderManifest({ schemaVersion: 1 })).toEqual(expect.arrayContaining([
      "files must be an object",
      "audio must be an object",
      "events must be an object",
    ]));
  });

  it("keeps the persisted user track contiguous and applies wall-clock gaps only in conversation.wav", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, {
        output_dir: dir,
        user_sample_rate_hz: 16000,
      });
      const start = bus.start();

      bus.push(Route.Main, {
        kind: "record.user_audio",
        contextId: "turn-1",
        timestampMs: 0,
        audio: new Uint8Array(320).fill(0x11),
      } satisfies RecordUserAudioPacket);
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      // Advance 100ms → 3200 bytes at 16 kHz. Second chunk lands at wall-clock byteOffset=3200.
      vi.setSystemTime(100);

      bus.push(Route.Main, {
        kind: "record.user_audio",
        contextId: "turn-2",
        timestampMs: 100,
        audio: new Uint8Array(320).fill(0x22),
      } satisfies RecordUserAudioPacket);
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      bus.stop();
      await start;
      const closePromise = recorder.close();
      await vi.runOnlyPendingTimersAsync();
      await closePromise;

      // Persisted user track: contiguous speech only (no inter-turn silence).
      const userPcm = await readFile(join(dir, "user_audio.pcm"));
      expect(userPcm.byteLength).toBe(640);
      expect(userPcm.subarray(0, 320)).toEqual(Buffer.alloc(320, 0x11));
      expect(userPcm.subarray(320, 640)).toEqual(Buffer.alloc(320, 0x22));

      // conversation.wav LEFT (user) channel: wall-clock positioned with the silence gap.
      const wav = await readFile(join(dir, "conversation.wav"));
      const data = wav.subarray(44);
      const frames = data.byteLength >> 2;
      const left = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) data.copy(left, i * 2, i * 4, i * 4 + 2);
      expect(left.byteLength).toBe(3520);
      expect(left.subarray(0, 320)).toEqual(Buffer.alloc(320, 0x11));
      expect(left.subarray(320, 3200)).toEqual(Buffer.alloc(2880, 0));
      expect(left.subarray(3200, 3520)).toEqual(Buffer.alloc(320, 0x22));
    });
  });

  it("writes stereo conversation.wav with user on L and assistant on R", async () => {
    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, {
        output_dir: dir,
        user_sample_rate_hz: 16000,
        assistant_sample_rate_hz: 16000,
      });
      const start = bus.start();

      const userSample = 0x0100;
      const assistSample = 0x0200;
      const userBytes = Buffer.alloc(8);
      const assistBytes = Buffer.alloc(8);
      for (let i = 0; i < 4; i++) {
        userBytes.writeInt16LE(userSample, i * 2);
        assistBytes.writeInt16LE(assistSample, i * 2);
      }

      bus.push(Route.Main, {
        kind: "record.user_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(userBytes),
      } satisfies RecordUserAudioPacket);
      bus.push(Route.Main, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(assistBytes),
        sampleRateHz: 16000,
        truncate: false,
      } satisfies RecordAssistantAudioPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));
      bus.stop();
      await start;
      await recorder.close();

      const wav = await readFile(join(dir, "conversation.wav"));
      // channels field at offset 22
      expect(wav.readUInt16LE(22)).toBe(2);
      // sample rate at offset 24
      expect(wav.readUInt32LE(24)).toBe(16000);
      // 4 stereo frames = 16 bytes PCM; total = 44 + 16 = 60
      expect(wav.byteLength).toBe(60);
      // Frame 0: L = userSample, R = assistSample
      expect(wav.readInt16LE(44)).toBe(userSample);
      expect(wav.readInt16LE(46)).toBe(assistSample);
      // Frame 1 same
      expect(wav.readInt16LE(48)).toBe(userSample);
      expect(wav.readInt16LE(50)).toBe(assistSample);
    });
  });

  it("resamples assistant audio from 24kHz to user rate when rates differ", async () => {
    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, {
        output_dir: dir,
        user_sample_rate_hz: 16000,
        assistant_sample_rate_hz: 24000,
      });
      const start = bus.start();

      // User: 160 samples = 10ms at 16kHz
      bus.push(Route.Main, {
        kind: "record.user_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(320),
      } satisfies RecordUserAudioPacket);
      // Assistant: 240 samples = 10ms at 24kHz
      bus.push(Route.Main, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(480),
        sampleRateHz: 24000,
        truncate: false,
      } satisfies RecordAssistantAudioPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));
      bus.stop();
      await start;
      await recorder.close();

      const wav = await readFile(join(dir, "conversation.wav"));
      // Resampled assistant: round(240 * 16000 / 24000) = 160 samples
      // Both tracks: 160 samples → 160 stereo frames × 4 bytes = 640 bytes PCM
      expect(wav.byteLength).toBe(44 + 640);
      expect(wav.readUInt16LE(22)).toBe(2);
      expect(wav.readUInt32LE(24)).toBe(16000);
    });
  });

  it("includes conversation entry in manifest and validates it", async () => {
    await withTempDir(async (dir) => {
      const bus = new PipelineBusImpl();
      const recorder = new VoiceSessionRecorder();
      await recorder.initialize(bus, {
        output_dir: dir,
        user_sample_rate_hz: 16000,
        assistant_sample_rate_hz: 16000,
      });
      const start = bus.start();

      // 3200 bytes = 100ms at 16kHz
      bus.push(Route.Main, {
        kind: "record.user_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(3200),
      } satisfies RecordUserAudioPacket);
      bus.push(Route.Main, {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(3200),
        sampleRateHz: 16000,
        truncate: false,
      } satisfies RecordAssistantAudioPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));
      bus.stop();
      await start;
      await recorder.close();

      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Record<string, any>;
      expect(manifest.audio.conversation).toMatchObject({
        channels: 2,
        encoding: "pcm_s16le",
        sampleRateHz: 16000,
        // 1600 user samples + 1600 assistant samples interleaved = 3200 stereo frames × 2 bytes × 2 ch = 6400
        byteLength: 6400,
        durationMs: 100,
      });
      expect(manifest.audio.conversation.path).toBe(join(dir, "conversation.wav"));
      expect(validateVoiceSessionRecorderManifest(manifest)).toStrictEqual([]);
    });
  });
});

function makeRecorderManifest(): VoiceSessionRecorderManifest {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    startedAtMs: 1000,
    closedAtMs: 2000,
    files: {
      directory: "/tmp/session-1",
      eventsPath: "/tmp/session-1/events.jsonl",
      userAudioPath: "/tmp/session-1/user_audio.pcm",
      assistantAudioPath: "/tmp/session-1/assistant_audio.pcm",
      manifestPath: "/tmp/session-1/manifest.json",
    },
    audio: {
      user: {
        path: "/tmp/session-1/user_audio.pcm",
        sampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: 3200,
        durationMs: 100,
        chunks: 1,
      },
      assistant: {
        path: "/tmp/session-1/assistant_audio.pcm",
        sampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: 3200,
        durationMs: 100,
        chunks: 1,
        truncations: 0,
      },
    },
    events: {
      path: "/tmp/session-1/events.jsonl",
      packets: 4,
      byteLength: 256,
    },
  };
}
