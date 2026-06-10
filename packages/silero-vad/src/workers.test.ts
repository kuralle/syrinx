// SPDX-License-Identifier: MIT

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineBus } from "@kuralle-syrinx/core";

import { SileroVADPlugin } from "./workers.js";

const mockControl = vi.hoisted(() => ({
  confidence: 0.9,
  stateCallArgs: [] as Float32Array[],
}));

vi.mock("onnxruntime-web", () => {
  function MockTensor(this: { data: unknown }, _type: string, data: unknown, _shape: unknown) {
    this.data = data;
  }
  const run = vi.fn(async (inputs: Record<string, { data: unknown }>) => {
    const state = inputs["state"]?.data;
    if (state instanceof Float32Array) {
      mockControl.stateCallArgs.push(new Float32Array(state));
    }
    return {
      output: { data: [mockControl.confidence] },
      stateN: { data: new Float32Array(2 * 1 * 128).fill(0.5) },
    };
  });
  return {
    InferenceSession: { create: vi.fn(async () => ({ run })) },
    Tensor: MockTensor,
  };
});

function makeBus(): { bus: PipelineBus; emitted: Array<{ kind: string }> } {
  const emitted: Array<{ kind: string }> = [];
  const bus = {
    push(_route: unknown, pkt: unknown) {
      emitted.push(pkt as { kind: string });
    },
    on(_event: string, _handler: unknown) {
      return () => {};
    },
  } as unknown as PipelineBus;
  return { bus, emitted };
}

function makePcmFrame(): Uint8Array {
  return new Uint8Array(512 * 2);
}

async function initPlugin(bus: PipelineBus, config: Record<string, unknown> = {}): Promise<SileroVADPlugin> {
  const plugin = new SileroVADPlugin();
  await plugin.initialize(bus, { model_bytes: new Uint8Array(8), ...config });
  return plugin;
}

function countKind(emitted: Array<{ kind: string }>, kind: string): number {
  return emitted.filter((p) => p.kind === kind).length;
}

function metricValue(
  emitted: Array<{ kind: string; name?: string; value?: string }>,
  name: string,
): string | undefined {
  return emitted.find((p) => p.kind === "metric.conversation" && p.name === name)?.value;
}

describe("SileroVADPlugin (Workers) — shared state machine parity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockControl.confidence = 0.9;
    mockControl.stateCallArgs.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function frame(plugin: SileroVADPlugin, confidence: number): Promise<void> {
    mockControl.confidence = confidence;
    await plugin.processAudio(makePcmFrame(), "ctx-w");
  }

  it("absorbs single-frame confidence spikes during stopping so speech still ends", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus);

    await frame(plugin, 0.9);
    expect(countKind(emitted, "vad.speech_started")).toBe(1);

    for (const confidence of [0.2, 0.2, 0.2, 0.2, 0.9, 0.2, 0.2, 0.2, 0.2, 0.2]) {
      await frame(plugin, confidence);
    }

    expect(countKind(emitted, "vad.speech_ended")).toBe(1);
    expect(metricValue(emitted, "vad.stop_hangover_ms")).toBeDefined();
  });

  it("resets model state during prolonged continuous speech (saturation guard)", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus);

    await frame(plugin, 0.9);
    vi.setSystemTime(13_000);
    await frame(plugin, 0.9);
    await frame(plugin, 0.9);

    expect(metricValue(emitted, "vad.state_reset_in_speech")).toBe("1");
    expect(mockControl.stateCallArgs[2]!.every((value) => value === 0)).toBe(true);
  });

  it("two consecutive speech frames during stopping resume speaking", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus);

    await frame(plugin, 0.9);
    for (const confidence of [0.2, 0.2, 0.2]) await frame(plugin, confidence);
    for (const confidence of [0.9, 0.9]) await frame(plugin, confidence);
    expect(countKind(emitted, "vad.speech_ended")).toBe(0);

    for (let i = 0; i < 9; i += 1) await frame(plugin, 0.2);
    expect(countKind(emitted, "vad.speech_ended")).toBe(1);
  });
});
