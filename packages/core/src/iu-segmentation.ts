// SPDX-License-Identifier: MIT
//
// Session-owned turn segmentation on the IU ledger.

import type { IncrementalUnit, IncrementalUnitId } from "./incremental-unit.js";
import {
  InMemoryIuLedger,
  type IuLedger,
  type IuLedgerAnomaly,
} from "./iu-ledger.js";

/** PluginConfig key for injecting the session-owned ledger into consumers (e.g. ReasoningBridge). */
export const IU_LEDGER_CONFIG_KEY = "iu_ledger";

export function isIuLedger(value: unknown): value is IuLedger {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IuLedger>;
  return (
    typeof candidate.add === "function" &&
    typeof candidate.commit === "function" &&
    typeof candidate.revoke === "function" &&
    typeof candidate.get === "function"
  );
}

/**
 * Records hypothesize → commit boundaries for user and assistant turns on one ledger
 * per session. ID scheme matches ReasoningBridge ({contextId, iuId, epoch}).
 */
export class TurnSegmentation {
  readonly ledger: InMemoryIuLedger;
  private readonly epochByContext = new Map<string, number>();
  private turnEpochCounter = 0;
  private readonly backchannelContexts = new Set<string>();
  private readonly transcriptIuByContext = new Map<
    string,
    { user?: IncrementalUnitId; assistant?: IncrementalUnitId }
  >();
  private entryCount = 0;
  private readonly entryCountByContext = new Map<string, number>();

  constructor(onAnomaly: (a: IuLedgerAnomaly) => void) {
    this.ledger = new InMemoryIuLedger(onAnomaly);
  }

  markBackchannel(contextId: string): void {
    this.backchannelContexts.add(contextId);
    const removed = this.entryCountByContext.get(contextId) ?? 0;
    if (removed > 0) {
      this.entryCount -= removed;
      this.entryCountByContext.delete(contextId);
      this.ledger.clear(contextId);
    }
    this.transcriptIuByContext.delete(contextId);
  }

  resetContext(contextId: string): void {
    this.backchannelContexts.delete(contextId);
    this.transcriptIuByContext.delete(contextId);
  }

  isBackchannel(contextId: string): boolean {
    return this.backchannelContexts.has(contextId);
  }

  /** Advance turn identity when a contextId is reused across turns. */
  beginTurn(contextId: string): void {
    this.turnEpochCounter += 1;
    this.epochByContext.set(contextId, this.turnEpochCounter);
    this.transcriptIuByContext.delete(contextId);
  }

  userIuId(contextId: string): IncrementalUnitId {
    return { contextId, iuId: contextId, epoch: this.epochFor(contextId) };
  }

  assistantIuId(contextId: string): IncrementalUnitId {
    return { contextId, iuId: `${contextId}#assistant`, epoch: this.epochFor(contextId) };
  }

  onSttPartial(contextId: string): IncrementalUnitId | undefined {
    if (this.isBackchannel(contextId)) return undefined;
    const id = this.userIuId(contextId);
    this.recordAdd({ id, kind: "user_turn", state: "hypothesized" });
    this.trackTranscript(contextId, "user", id);
    return id;
  }

  onSttResult(contextId: string): void {
    if (this.isBackchannel(contextId)) return;
    this.ledger.commit(this.userIuId(contextId));
  }

  onAssistantResponseStart(contextId: string): IncrementalUnitId | undefined {
    if (this.isBackchannel(contextId)) return undefined;
    const id = this.assistantIuId(contextId);
    const existing = this.ledger.get(id);
    if (existing) {
      this.trackTranscript(contextId, "assistant", id);
      return id;
    }
    this.recordAdd({ id, kind: "assistant_response", state: "hypothesized" });
    this.trackTranscript(contextId, "assistant", id);
    return id;
  }

  onPlayoutComplete(contextId: string): void {
    if (this.isBackchannel(contextId)) return;
    const id = this.assistantIuId(contextId);
    if (this.ledger.get(id)?.state === "hypothesized") {
      this.ledger.commit(id);
    }
  }

  onAssistantBargeIn(contextId: string, playedMs: number): void {
    if (this.isBackchannel(contextId)) return;
    const id = this.assistantIuId(contextId);
    const iu = this.ledger.get(id);
    if (!iu) return;
    const prefix = { ms: playedMs };
    if (iu.state === "hypothesized") {
      this.ledger.commit(id, prefix);
    } else if (iu.state === "committed") {
      iu.committedPrefix = prefix;
    }
  }

  requireTranscriptIu(contextId: string, role: "user" | "assistant"): IncrementalUnitId {
    const id = this.transcriptIuByContext.get(contextId)?.[role];
    if (!id) {
      throw new Error(`transcript emission without ledger entry: ${contextId}/${role}`);
    }
    return id;
  }

  /** Test seam: total distinct IUs recorded (adds that created a new slot). */
  countEntries(): number {
    return this.entryCount;
  }

  private epochFor(contextId: string): number {
    let epoch = this.epochByContext.get(contextId);
    if (epoch === undefined) {
      epoch = ++this.turnEpochCounter;
      this.epochByContext.set(contextId, epoch);
    }
    return epoch;
  }

  private recordAdd(iu: IncrementalUnit): void {
    const prior = this.ledger.get(iu.id);
    this.ledger.add(iu);
    if (!prior) {
      this.entryCount += 1;
      const ctx = iu.id.contextId;
      this.entryCountByContext.set(ctx, (this.entryCountByContext.get(ctx) ?? 0) + 1);
    }
  }

  private trackTranscript(contextId: string, role: "user" | "assistant", id: IncrementalUnitId): void {
    const existing = this.transcriptIuByContext.get(contextId) ?? {};
    this.transcriptIuByContext.set(contextId, { ...existing, [role]: id });
  }

}
