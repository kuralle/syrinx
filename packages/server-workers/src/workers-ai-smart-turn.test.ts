// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { WorkersAiSmartTurnPredictor, type Ai } from "./workers-ai-smart-turn.js";

function mockAi(result: { is_complete?: boolean; probability?: number }): Ai {
  return {
    run: async (model: string, input: unknown) => {
      return { ...result };
    },
  };
}

describe("WorkersAiSmartTurnPredictor", () => {
  it("calls ai.run with the v2 model, float32 dtype, and base64 audio", async () => {
    const calls: Array<{ model: string; input: unknown }> = [];
    const ai: Ai = {
      run: async (model, input) => {
        calls.push({ model, input });
        return { is_complete: true, probability: 0.9 };
      },
    };
    const predictor = new WorkersAiSmartTurnPredictor(ai);
    await predictor.initialize({});

    const audio = new Float32Array([0.1, -0.2, 0.3]);
    const probability = await predictor.predict(audio);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.model).toBe("@cf/pipecat-ai/smart-turn-v2");

    const input = call.input as Record<string, unknown>;
    expect(input.dtype).toBe("float32");
    expect(typeof input.audio).toBe("string");

    // Verify base64 decodes back to the same Float32Array bytes
    const decoded = atob(input.audio as string);
    const decodedBytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      decodedBytes[i] = decoded.charCodeAt(i);
    }
    const decodedFloats = new Float32Array(decodedBytes.buffer);
    expect(decodedFloats).toEqual(audio);

    expect(probability).toBe(0.9);
  });

  it("returns 0 when probability is missing", async () => {
    const predictor = new WorkersAiSmartTurnPredictor(mockAi({ is_complete: true }));
    await predictor.initialize({});
    const probability = await predictor.predict(new Float32Array([0.5]));
    expect(probability).toBe(0);
  });

  it("returns 0 when probability is undefined", async () => {
    const predictor = new WorkersAiSmartTurnPredictor(mockAi({ is_complete: false, probability: undefined }));
    await predictor.initialize({});
    const probability = await predictor.predict(new Float32Array([0.5]));
    expect(probability).toBe(0);
  });

  it("close is a no-op", async () => {
    const predictor = new WorkersAiSmartTurnPredictor(mockAi({ probability: 0.5 }));
    await expect(predictor.close()).resolves.toBeUndefined();
  });
});
