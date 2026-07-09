// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Incremental-Unit identity + state (IU substrate, RFC incremental-unit-substrate)

export type IuState = "hypothesized" | "committed" | "revoked";

export interface IncrementalUnitId {
  readonly contextId: string;
  readonly iuId: string;
  readonly epoch: number;
}

export interface IncrementalUnit {
  readonly id: IncrementalUnitId;
  readonly kind: "user_turn" | "assistant_response" | "tts_segment";
  state: IuState;
  /** For assistant/tts IUs: the committed character/ms prefix (heard). */
  committedPrefix?: { chars?: number; ms?: number };
}