// SPDX-License-Identifier: MIT
//
// Derived transcript views over the session IU ledger.

import type { IncrementalUnitId, IuState } from "./incremental-unit.js";
import type { IuLedger } from "./iu-ledger.js";

export interface TranscriptMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly iuId: string;
  readonly state: IuState;
}

export interface TranscriptViews {
  speculativeTranscript(contextId?: string): readonly TranscriptMessage[];
  committedTranscript(contextId?: string): readonly TranscriptMessage[];
}

export function formatTranscriptIuId(id: IncrementalUnitId): string {
  return `${id.contextId}:${id.iuId}:${id.epoch}`;
}

export function applyCommittedPrefix(
  text: string,
  prefix?: { readonly chars?: number; readonly ms?: number },
): string {
  if (prefix?.chars !== undefined) {
    return text.slice(0, prefix.chars);
  }
  return text;
}

export function buildTranscriptView(
  ledger: IuLedger,
  sequence: readonly IncrementalUnitId[],
  textByKey: ReadonlyMap<string, string>,
  isBackchannel: (contextId: string) => boolean,
  contextId: string | undefined,
  includeState: (state: IuState) => boolean,
): readonly TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const id of sequence) {
    if (contextId !== undefined && id.contextId !== contextId) continue;
    if (isBackchannel(id.contextId)) continue;
    const iu = ledger.get(id);
    if (!iu || !includeState(iu.state)) continue;
    if (iu.kind === "tts_segment") continue;
    const role = iu.kind === "user_turn" ? "user" : "assistant";
    const text = applyCommittedPrefix(textByKey.get(iuStorageKey(id)) ?? "", iu.committedPrefix);
    out.push({
      role,
      text,
      iuId: formatTranscriptIuId(id),
      state: iu.state,
    });
  }
  return out;
}

export function iuStorageKey(id: IncrementalUnitId): string {
  return `${id.contextId}\0${id.iuId}\0${id.epoch}`;
}
