// SPDX-License-Identifier: MIT

import type { PluginConfig } from "@kuralle-syrinx/core";

/** Host- or model-agnostic Smart Turn probability scorer. */
export interface SmartTurnPredictor {
  initialize(config: PluginConfig): Promise<void>;
  predict(audio: Float32Array): Promise<number>;
  close(): Promise<void>;
}
