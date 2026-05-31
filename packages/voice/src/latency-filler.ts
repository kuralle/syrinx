// SPDX-License-Identifier: MIT
//
// VE-03 / G24 — latency-hiding dual-track filler (DDTSR direction).
// Emits a short discourse connective at endpoint while the main LLM spins up.

export const LATENCY_FILLER_CONNECTIVES = [
  "So,",
  "Well,",
  "Right,",
  "Okay,",
  "Hmm,",
] as const;

export type LatencyFillerConnective = (typeof LATENCY_FILLER_CONNECTIVES)[number];

export interface LatencyFillerState {
  readonly text: string;
  active: boolean;
  spliced: boolean;
  cancelled: boolean;
  readonly startedAtMs: number;
}

export interface LatencyFillerConfig {
  readonly enabled?: boolean;
}

export class LatencyFillerController {
  private readonly enabled: boolean;
  private turnIndex = 0;
  private readonly states = new Map<string, LatencyFillerState>();

  constructor(config: LatencyFillerConfig = {}) {
    this.enabled = config.enabled === true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  start(contextId: string, userText: string, nowMs = Date.now()): string | null {
    if (!this.enabled) return null;
    if (this.states.has(contextId)) return null;
    const text = selectLatencyFillerConnective(userText, this.turnIndex);
    this.turnIndex += 1;
    this.states.set(contextId, {
      text,
      active: true,
      spliced: false,
      cancelled: false,
      startedAtMs: nowMs,
    });
    return text;
  }

  getState(contextId: string): LatencyFillerState | undefined {
    return this.states.get(contextId);
  }

  isActive(contextId: string): boolean {
    const state = this.states.get(contextId);
    return state?.active === true && state.cancelled !== true;
  }

  isFillerOnly(contextId: string): boolean {
    const state = this.states.get(contextId);
    return state?.active === true && state.spliced !== true && state.cancelled !== true;
  }

  spliceLlmDelta(contextId: string, delta: string): string {
    const state = this.states.get(contextId);
    if (!state || state.cancelled || state.spliced) return delta;
    state.spliced = true;
    return stripRedundantFillerPrefix(state.text, delta);
  }

  cancel(contextId: string): LatencyFillerState | null {
    const state = this.states.get(contextId);
    if (!state || state.cancelled) return null;
    state.cancelled = true;
    state.active = false;
    return state;
  }

  clear(contextId: string): void {
    this.states.delete(contextId);
  }
}

export function selectLatencyFillerConnective(userText: string, turnIndex: number): string {
  const trimmed = userText.trim().toLowerCase();
  if (trimmed.endsWith("?")) return "Well,";
  if (/\b(thanks|thank you)\b/.test(trimmed)) return "Right,";
  const pool = LATENCY_FILLER_CONNECTIVES;
  return pool[((turnIndex % pool.length) + pool.length) % pool.length]!;
}

export function stripRedundantFillerPrefix(fillerText: string, llmText: string): string {
  const fillerWord = fillerText.replace(/[.,!?…\s]+$/g, "").trim().toLowerCase();
  if (!fillerWord) return llmText;

  const body = llmText.trimStart();
  const lowerBody = body.toLowerCase();

  if (lowerBody.startsWith(fillerWord)) {
    let rest = body.slice(fillerWord.length);
    rest = rest.replace(/^[\s,]+/, "");
    return rest;
  }

  const withPunct = `${fillerWord},`;
  if (lowerBody.startsWith(withPunct)) {
    let rest = body.slice(withPunct.length);
    rest = rest.replace(/^[\s,]+/, "");
    return rest;
  }

  return llmText;
}
