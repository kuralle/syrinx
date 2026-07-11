// SPDX-License-Identifier: MIT

import type { SmartTurnPredictor } from "@kuralle-syrinx/pipecat-smart-turn";
import type { PluginConfig } from "@kuralle-syrinx/core";

/** Minimal Cloudflare Workers AI binding surface for the Smart Turn v2 model. */
export interface Ai {
  run(model: string, input: unknown): Promise<{
    is_complete?: boolean;
    probability?: number;
  }>;
}

const MODEL_ID = "@cf/pipecat-ai/smart-turn-v2";

/**
 * Cloudflare Workers AI-hosted Smart Turn predictor.
 *
 * Uses the hosted `@cf/pipecat-ai/smart-turn-v2` model (v3 is NOT available in the
 * Workers AI catalog). No ONNX is loaded locally — the model runs in Cloudflare's
 * inference cluster, so `initialize`/`close` are no-ops.
 */
export class WorkersAiSmartTurnPredictor implements SmartTurnPredictor {
  constructor(private readonly ai: Ai) {}

  async initialize(_config: PluginConfig): Promise<void> {
    // Hosted model — nothing to load.
  }

  async predict(audio: Float32Array): Promise<number> {
    const base64 = float32ArrayToBase64(audio);
    const result = await this.ai.run(MODEL_ID, { audio: base64, dtype: "float32" });
    return typeof result.probability === "number" ? result.probability : 0;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

function float32ArrayToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  const chunks: string[] = [];
  const chunkSize = 0x8000; // 32 KB — safe for String.fromCharCode spread
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}
