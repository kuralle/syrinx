// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineBus } from "@kuralle-syrinx/core";

import { SileroVADPlugin } from "./index.js";

// Shared mutable state that the vi.mock factory can close over via vi.hoisted.
const mockControl = vi.hoisted(() => ({
  confidence: 0.9,
  stateCallArgs: [] as Float32Array[],
}));

vi.mock("onnxruntime-node", () => {
  // Minimal Tensor stand-in — stores data so session.run() can read it back.
  function MockTensor(
    this: { data: unknown },
    _type: string,
    data: unknown,
    _shape: unknown,
  ) {
    this.data = data;
  }

  const run = vi.fn(async (inputs: Record<string, { data: unknown }>) => {
    const state = inputs["state"]?.data;
    if (state instanceof Float32Array) {
      mockControl.stateCallArgs.push(new Float32Array(state));
    }
    // Return a distinctive non-zero state so a subsequent reset is detectable.
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

// ── helpers ────────────────────────────────────────────────────────────────

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

/** 512-sample (32 ms) silent PCM frame — value irrelevant since model is mocked. */
function makePcmFrame(): Uint8Array {
  return new Uint8Array(512 * 2);
}

async function initPlugin(
  bus: PipelineBus,
  config: Record<string, unknown> = {},
): Promise<SileroVADPlugin> {
  const plugin = new SileroVADPlugin();
  await plugin.initialize(bus, { model_path: "/dev/null", ...config });
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

// ── tests ──────────────────────────────────────────────────────────────────

describe("SileroVADPlugin — G11: periodic state reset gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockControl.confidence = 0.9;
    mockControl.stateCallArgs.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not reset model state mid-speech when the 5 s timer elapses", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus);

    // Frame 1 (T=0): confidence=0.9 → speech_started, vadState=speaking.
    // stateCallArgs[0] = all-zeros (initial state).
    await plugin.processAudio(makePcmFrame(), "ctx-1");
    expect(emitted.some((p) => p.kind === "vad.speech_started")).toBe(true);

    // Advance past the 5 s reset boundary while still speaking.
    vi.setSystemTime(6000);

    // Frame 2 (T=6000): fix must skip the reset because vadState=speaking.
    // stateCallArgs[1] = [0.5...] (state updated by frame 1 output).
    // After this call, state stays [0.5...] (no reset).
    await plugin.processAudio(makePcmFrame(), "ctx-1");

    // Frame 3 (T=6000): if a reset had fired after frame 2, this call would
    // receive all-zero state.  With the fix it receives the non-zero value.
    await plugin.processAudio(makePcmFrame(), "ctx-1");

    expect(emitted.some((p) => p.kind === "vad.speech_ended")).toBe(false);

    // State entering frame 3 must still carry the non-zero value from the mock
    // (0.5), proving no mid-speech reset occurred.
    const stateAtFrame3 = mockControl.stateCallArgs[2];
    expect(stateAtFrame3).toBeDefined();
    expect(stateAtFrame3!.some((v) => v !== 0)).toBe(true);

    await plugin.close();
  });

  it("resets model state at the 5 s boundary once speech has ended", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus);

    // Frame 1 (T=0): speech starts.
    mockControl.confidence = 0.9;
    await plugin.processAudio(makePcmFrame(), "ctx-2");
    expect(emitted.some((p) => p.kind === "vad.speech_started")).toBe(true);

    // Switch to silence. silenceFrameTarget = ceil(200/32) = 7; speech ends when
    // silenceFrames*32 >= minSilenceDurationMs(200) + speechPadMs(80) = 280 ms,
    // i.e. after 9 consecutive silence frames (9*32=288 >= 280).
    mockControl.confidence = 0.1;
    for (let i = 0; i < 9; i++) {
      await plugin.processAudio(makePcmFrame(), "ctx-2");
    }
    expect(emitted.some((p) => p.kind === "vad.speech_ended")).toBe(true);

    // Time has not advanced yet; no reset should have fired (0 - 0 < 5000).
    // Now advance past the reset window.
    vi.setSystemTime(6000);

    // Frame at T=6000 (not speaking): reset fires after this run call.
    await plugin.processAudio(makePcmFrame(), "ctx-2");

    // One more frame: should receive all-zero state because the reset zeroed it.
    await plugin.processAudio(makePcmFrame(), "ctx-2");

    const lastStateArg = mockControl.stateCallArgs.at(-1);
    expect(lastStateArg).toBeDefined();
    expect(lastStateArg!.every((v) => v === 0)).toBe(true);

    await plugin.close();
  });
});

describe("SileroVADPlugin — four-state VAD (VE-02)", () => {
  beforeEach(() => {
    mockControl.confidence = 0.9;
    mockControl.stateCallArgs.length = 0;
  });

  it("vad_flap_rejected: sub-threshold speech burst does not emit speech_started", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus, { speech_start_duration_ms: 96 });

    mockControl.confidence = 0.9;
    await plugin.processAudio(makePcmFrame(), "ctx-flap");

    mockControl.confidence = 0.1;
    await plugin.processAudio(makePcmFrame(), "ctx-flap");

    expect(countKind(emitted, "vad.speech_started")).toBe(0);
    expect(metricValue(emitted, "vad.start_delay_ms")).toBeUndefined();

    await plugin.close();
  });

  it("vad_full_cycle: sustained speech then silence emits one start and one end", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus);

    mockControl.confidence = 0.9;
    for (let i = 0; i < 4; i++) {
      await plugin.processAudio(makePcmFrame(), "ctx-cycle");
    }
    expect(countKind(emitted, "vad.speech_started")).toBe(1);
    expect(metricValue(emitted, "vad.start_delay_ms")).toBe("32");

    mockControl.confidence = 0.1;
    for (let i = 0; i < 9; i++) {
      await plugin.processAudio(makePcmFrame(), "ctx-cycle");
    }
    expect(countKind(emitted, "vad.speech_ended")).toBe(1);
    expect(metricValue(emitted, "vad.stop_hangover_ms")).toBe("288");

    await plugin.close();
  });

  it("vad_resume_no_end: brief silence dip during speech does not emit speech_ended", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus);

    mockControl.confidence = 0.9;
    await plugin.processAudio(makePcmFrame(), "ctx-resume");
    expect(countKind(emitted, "vad.speech_started")).toBe(1);

    mockControl.confidence = 0.1;
    for (let i = 0; i < 3; i++) {
      await plugin.processAudio(makePcmFrame(), "ctx-resume");
    }
    expect(countKind(emitted, "vad.speech_ended")).toBe(0);

    mockControl.confidence = 0.9;
    await plugin.processAudio(makePcmFrame(), "ctx-resume");
    expect(countKind(emitted, "vad.speech_ended")).toBe(0);
    expect(countKind(emitted, "vad.speech_started")).toBe(1);

    await plugin.close();
  });

  it("default speech_start_duration_ms emits speech_started on the first speech frame", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus);

    mockControl.confidence = 0.9;
    await plugin.processAudio(makePcmFrame(), "ctx-default");

    expect(countKind(emitted, "vad.speech_started")).toBe(1);
    expect(metricValue(emitted, "vad.start_delay_ms")).toBe("32");

    await plugin.close();
  });
});

describe("SileroVADPlugin — odd byteOffset PCM (browser buffer alignment)", () => {
  beforeEach(() => {
    mockControl.confidence = 0.9;
    mockControl.stateCallArgs.length = 0;
  });

  it("processes a PCM frame whose byteOffset is odd without throwing", async () => {
    const { bus, emitted } = makeBus();
    const plugin = await initPlugin(bus);

    // Inbound browser PCM is frequently a Uint8Array view into a pooled Node
    // Buffer at an ODD byteOffset. `new Int16Array(buffer, oddOffset, …)` throws
    // "start offset of Int16Array should be a multiple of 2" — this reproduces it.
    const backing = new Uint8Array(512 * 2 + 1);
    const oddOffsetFrame = backing.subarray(1); // byteOffset 1 (odd), even length
    expect(oddOffsetFrame.byteOffset % 2).toBe(1);

    await expect(plugin.processAudio(oddOffsetFrame, "ctx-odd")).resolves.toBeUndefined();
    expect(emitted.some((p) => p.kind === "vad.error")).toBe(false);
    // Reached the model and emitted a VAD verdict — proof the frame was processed.
    expect(emitted.some((p) => p.kind === "vad.speech_started")).toBe(true);

    await plugin.close();
  });
});
