// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Plugin Contract
//
// Every pipeline plugin (STT, TTS, VAD, EOS, Denoiser, Bridge) implements
// this interface. Plugins receive the PipelineBus on initialization and
// push all output (transcripts, audio, errors, events) into the bus.
//
// Breaking change from v0.1: plugins now accept PipelineBus directly.
// No callbacks, no adapters. Clean contract, one code path.

import type { PipelineBus } from "./pipeline-bus.js";

// =============================================================================
// Contract
// =============================================================================

export type EndpointingOwner = "provider_stt" | "smart_turn";

export interface EndpointingCapability {
  readonly owner: EndpointingOwner;
  readonly disableConfig?: PluginConfig;
}

export interface VoicePlugin {
  readonly endpointingCapability?: EndpointingCapability;

  /**
   * Initialize the plugin. Called during the init chain.
   * Connect to provider, start streams, register bus handlers if needed.
   *
   * @param bus — The session's PipelineBus. Push all output packets here.
   * @param config — Plugin-specific configuration (API keys, model IDs, etc.).
   */
  initialize(bus: PipelineBus, config: PluginConfig): Promise<void>;

  /**
   * Tear down the plugin. Called during the finalize chain (reverse order).
   * Close connections, flush buffers, release resources.
   */
  close(): Promise<void>;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Plugin configuration — a flat key-value bag.
 * Plugins extract the keys they need (e.g., "api_key", "model_id", "voice_id").
 */
export type PluginConfig = Record<string, unknown>;

/**
 * Convenience: extract a string config value, throwing if missing.
 */
export function requireStringConfig(
  config: PluginConfig,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Plugin config missing required key: ${key}`);
  }
  return value;
}

/**
 * Convenience: extract an optional string config value.
 */
export function optionalStringConfig(
  config: PluginConfig,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
