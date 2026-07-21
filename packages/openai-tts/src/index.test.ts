// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
  type UsageRecordedPacket,
} from "@kuralle-syrinx/core";

import { OpenAICompatibleTTSPlugin } from "./index.js";

function startBus(bus: PipelineBusImpl): Promise<void> {
  return bus.start();
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for openai-tts test condition");
}

/** Minimal mono s16le silence: `sampleCount` samples (`sampleCount * 2` bytes). */
function pcmSilence(sampleCount: number): Uint8Array {
  return new Uint8Array(sampleCount * 2);
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]!);
      i += 1;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAICompatibleTTSPlugin", () => {
  it("emits usage.recorded with stage tts and characters equal to synthesized text length", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(streamFromChunks([pcmSilence(8)]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new OpenAICompatibleTTSPlugin();
    const ends: TextToSpeechEndPacket[] = [];
    const usage: UsageRecordedPacket[] = [];
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    const text = "Hello usage.";
    await plugin.initialize(bus, {
      base_url: "https://tts.test/v1",
      model: "gpt-4o-mini-tts",
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-usage",
      timestampMs: Date.now(),
      text,
    });
    await waitForCondition(() => ends.length >= 1 && usage.length >= 1);

    expect(usage).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "turn-usage",
        stage: "tts",
        provider: "openai",
        model: "gpt-4o-mini-tts",
        characters: text.length,
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("POSTs speech body with stream, pcm, and extra_body merged", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Response(streamFromChunks([pcmSilence(8)]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new OpenAICompatibleTTSPlugin();
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      base_url: "https://zeta.test/v1",
      sample_rate: 16000,
      extra_body: { task_type: "Base", num_steps: 8 },
    });

    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "ආයුබෝවන්",
    });
    await waitForCondition(() => ends.length >= 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://zeta.test/v1/audio/speech");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: "gpt-4o-mini-tts",
      input: "ආයුබෝවන්",
      response_format: "pcm",
      stream: true,
      task_type: "Base",
      num_steps: 8,
    });
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    await plugin.close();
    bus.stop();
    await started;
  });

  it("includes voice in body only when configured", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Response(streamFromChunks([pcmSilence(8)]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new OpenAICompatibleTTSPlugin();
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      base_url: "https://openai.test/v1",
      api_key: "sk-test",
      voice: "alloy",
      sample_rate: 16000,
    });

    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-voice",
      timestampMs: Date.now(),
      text: "hello",
    });
    await waitForCondition(() => ends.length >= 1);

    const [_url, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.voice).toBe("alloy");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");

    await plugin.close();
    bus.stop();
    await started;
  });

  it("omits voice key when voice is not configured", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Response(streamFromChunks([pcmSilence(8)]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new OpenAICompatibleTTSPlugin();
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      base_url: "https://openai.test/v1",
      sample_rate: 16000,
    });

    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-no-voice",
      timestampMs: Date.now(),
      text: "hi",
    });
    await waitForCondition(() => ends.length >= 1);

    const [_url, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("voice");

    await plugin.close();
    bus.stop();
    await started;
  });

  it("streams PCM into tts.audio at engine sampleRateHz then tts.end", async () => {
    // Two chunks with an odd-byte split so the plugin must carry across frames.
    const full = pcmSilence(48); // 96 bytes
    const chunkA = full.subarray(0, 15); // odd
    const chunkB = full.subarray(15);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(streamFromChunks([chunkA, chunkB]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );

    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new OpenAICompatibleTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      base_url: "https://openai.test/v1",
      sample_rate: 16000,
    });

    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-2",
      timestampMs: Date.now(),
      text: "hello",
    });
    await waitForCondition(() => ends.length >= 1);

    expect(audio.length).toBeGreaterThanOrEqual(1);
    for (const pkt of audio) {
      expect(pkt.kind).toBe("tts.audio");
      expect(pkt.contextId).toBe("turn-2");
      expect(pkt.sampleRateHz).toBe(16000);
      expect(pkt.audio.byteLength % 2).toBe(0);
      expect(pkt.audio.byteLength).toBeGreaterThan(0);
    }
    expect(ends).toEqual([expect.objectContaining({ kind: "tts.end", contextId: "turn-2" })]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("source_sample_rate_hz drives the resampler output length", async () => {
    // 96 bytes = 48 samples. Different source rates → different resampled lengths.
    const pcm48k = pcmSilence(48);

    async function collectAudioBytes(sourceRate: number): Promise<number> {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(streamFromChunks([pcm48k]), {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }),
      );

      const bus = new PipelineBusImpl();
      const started = startBus(bus);
      const plugin = new OpenAICompatibleTTSPlugin();
      let totalBytes = 0;
      const ends: TextToSpeechEndPacket[] = [];
      bus.on("tts.audio", (pkt) => {
        totalBytes += (pkt as TextToSpeechAudioPacket).audio.byteLength;
      });
      bus.on("tts.end", (pkt) => {
        ends.push(pkt as TextToSpeechEndPacket);
      });

      await plugin.initialize(bus, {
        base_url: "https://openai.test/v1",
        sample_rate: 16000,
        source_sample_rate_hz: sourceRate,
      });

      bus.push(Route.Main, {
        kind: "tts.text",
        contextId: `rate-${String(sourceRate)}`,
        timestampMs: Date.now(),
        text: "test",
      });
      await waitForCondition(() => ends.length >= 1);

      await plugin.close();
      bus.stop();
      await started;
      vi.unstubAllGlobals();
      return totalBytes;
    }

    const bytesAt48k = await collectAudioBytes(48_000);
    const bytesAt24k = await collectAudioBytes(24_000);
    expect(bytesAt48k).toBeGreaterThan(0);
    expect(bytesAt24k).toBeGreaterThan(bytesAt48k);
  });

  it("tempo: 0.9 produces more tts.audio bytes than tempo: 1.0 for the same PCM stream", async () => {
    // ~100 ms of 24 kHz silence → enough samples after resample for WSOLA to stretch.
    const pcm = pcmSilence(2400);

    async function collectAudioBytes(tempo: number): Promise<number> {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(streamFromChunks([pcm]), {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }),
      );

      const bus = new PipelineBusImpl();
      const started = startBus(bus);
      const plugin = new OpenAICompatibleTTSPlugin();
      let totalBytes = 0;
      const ends: TextToSpeechEndPacket[] = [];
      bus.on("tts.audio", (pkt) => {
        totalBytes += (pkt as TextToSpeechAudioPacket).audio.byteLength;
      });
      bus.on("tts.end", (pkt) => {
        ends.push(pkt as TextToSpeechEndPacket);
      });

      await plugin.initialize(bus, {
        base_url: "https://openai.test/v1",
        sample_rate: 16000,
        tempo,
      });

      bus.push(Route.Main, {
        kind: "tts.text",
        contextId: `tempo-${String(tempo)}`,
        timestampMs: Date.now(),
        text: "slow",
      });
      await waitForCondition(() => ends.length >= 1);

      await plugin.close();
      bus.stop();
      await started;
      vi.unstubAllGlobals();
      return totalBytes;
    }

    const bytesAt1 = await collectAudioBytes(1.0);
    const bytesAt09 = await collectAudioBytes(0.9);
    expect(bytesAt1).toBeGreaterThan(0);
    expect(bytesAt09).toBeGreaterThan(bytesAt1);
  });

  it("maps HTTP 503 to a recoverable tts.error", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Service Unavailable", { status: 503 })),
    );

    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new OpenAICompatibleTTSPlugin();
    const errors: TtsErrorPacket[] = [];
    bus.on("tts.error", (pkt) => {
      errors.push(pkt as TtsErrorPacket);
    });

    await plugin.initialize(bus, {
      base_url: "https://openai.test/v1",
      sample_rate: 16000,
    });

    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-cold",
      timestampMs: Date.now(),
      text: "cold",
    });
    await waitForCondition(() => errors.length >= 1);

    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-cold",
        component: "tts",
        isRecoverable: true,
      }),
    ]);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("[openai-tts] cold start"),
    );

    await plugin.close();
    bus.stop();
    await started;
    errorLog.mockRestore();
  });

  it("prewarm issues GET {baseUrl}/models with auth when api_key is set", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bus = new PipelineBusImpl();
    const plugin = new OpenAICompatibleTTSPlugin();
    await plugin.initialize(bus, {
      base_url: "https://zeta.test/v1",
      api_key: "sk-test",
    });

    await plugin.prewarm();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://zeta.test/v1/models");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");

    await plugin.close();
  });

  it("swallows fetch rejection in prewarm", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const bus = new PipelineBusImpl();
    const plugin = new OpenAICompatibleTTSPlugin();
    await plugin.initialize(bus, { base_url: "https://zeta.test/v1" });

    await expect(plugin.prewarm()).resolves.toBeUndefined();

    await plugin.close();
  });
});
