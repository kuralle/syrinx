// SPDX-License-Identifier: MIT
//
// Session-owned turn segmentation on the IU ledger.

import type { IncrementalUnit, IncrementalUnitId } from "./incremental-unit.js";
import {
  InMemoryIuLedger,
  type IuLedger,
  type IuLedgerAnomaly,
} from "./iu-ledger.js";
import {
  buildTranscriptView,
  type TranscriptMessage,
  type TranscriptViews,
  iuStorageKey,
} from "./transcript-views.js";

export type { TranscriptMessage, TranscriptViews } from "./transcript-views.js";

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
  private readonly transcriptTextByKey = new Map<string, string>();
  private readonly userCommittedByKey = new Map<string, string>();
  private readonly userLiveByKey = new Map<string, string>();
  private readonly userPendingFinalByKey = new Map<string, boolean>();
  private readonly transcriptSequence: IncrementalUnitId[] = [];

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
    this.clearTranscriptText(contextId);
  }

  resetContext(contextId: string): void {
    this.backchannelContexts.delete(contextId);
    this.transcriptIuByContext.delete(contextId);
    this.clearTranscriptText(contextId);
  }

  isBackchannel(contextId: string): boolean {
    return this.backchannelContexts.has(contextId);
  }

  /** Advance turn identity when a contextId is reused across turns. */
  beginTurn(contextId: string): void {
    this.turnEpochCounter += 1;
    this.epochByContext.set(contextId, this.turnEpochCounter);
    this.transcriptIuByContext.delete(contextId);
    this.clearUserTranscriptAccumulation(contextId);
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
    // Both callers -- handleSttResult and handleTurnComplete -- run
    // onSttPartial -> onSttResult -> recordUserTranscript(finalText), so the
    // final text has not arrived yet. It supersedes the live interim rather
    // than following it, so committing the interim here would double-count the
    // segment. Mark the final as pending and let it land; the interim stays
    // displayed until it does.
    this.userPendingFinalByKey.set(iuStorageKey(this.userIuId(contextId)), true);
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

  recordUserTranscript(contextId: string, text: string): void {
    if (this.isBackchannel(contextId)) return;
    const id = this.userIuId(contextId);
    const key = iuStorageKey(id);
    if (this.userPendingFinalByKey.get(key)) {
      this.appendUserCommitted(key, text);
      this.userPendingFinalByKey.set(key, false);
      this.userLiveByKey.set(key, "");
    } else if (!this.isDuplicateUserFinal(key, text)) {
      this.userLiveByKey.set(key, text);
    }
    this.syncUserTranscriptDisplay(key);
    this.ensureTranscriptSequence(id);
  }

  appendAssistantTranscript(contextId: string, delta: string): void {
    if (this.isBackchannel(contextId)) return;
    const id = this.assistantIuId(contextId);
    const key = iuStorageKey(id);
    this.transcriptTextByKey.set(key, (this.transcriptTextByKey.get(key) ?? "") + delta);
    this.ensureTranscriptSequence(id);
  }

  setAssistantTranscript(contextId: string, text: string): void {
    if (this.isBackchannel(contextId)) return;
    this.onAssistantResponseStart(contextId);
    const id = this.assistantIuId(contextId);
    this.transcriptTextByKey.set(iuStorageKey(id), text);
    this.ensureTranscriptSequence(id);
  }

  setAssistantHeardPrefix(contextId: string, heardText: string, playedMs: number): void {
    if (this.isBackchannel(contextId)) return;
    const id = this.assistantIuId(contextId);
    this.transcriptTextByKey.set(iuStorageKey(id), heardText);
    this.ensureTranscriptSequence(id);
    const iu = this.ledger.get(id);
    if (!iu) return;
    iu.committedPrefix = { ms: playedMs, chars: heardText.length };
  }

  speculativeTranscript(contextId?: string): readonly TranscriptMessage[] {
    return buildTranscriptView(
      this.ledger,
      this.transcriptSequence,
      this.transcriptTextByKey,
      (ctx) => this.isBackchannel(ctx),
      contextId,
      (state) => state === "hypothesized" || state === "committed",
    );
  }

  committedTranscript(contextId?: string): readonly TranscriptMessage[] {
    return buildTranscriptView(
      this.ledger,
      this.transcriptSequence,
      this.transcriptTextByKey,
      (ctx) => this.isBackchannel(ctx),
      contextId,
      (state) => state === "committed",
    );
  }

  asTranscriptViews(): TranscriptViews {
    return {
      speculativeTranscript: (contextId) => this.speculativeTranscript(contextId),
      committedTranscript: (contextId) => this.committedTranscript(contextId),
    };
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
    this.ensureTranscriptSequence(id);
  }

  private ensureTranscriptSequence(id: IncrementalUnitId): void {
    const key = iuStorageKey(id);
    if (this.transcriptSequence.some((entry) => iuStorageKey(entry) === key)) return;
    this.transcriptSequence.push({ ...id });
  }

  private clearTranscriptText(contextId: string): void {
    this.clearUserTranscriptAccumulation(contextId);
    for (const [key] of this.transcriptTextByKey) {
      if (key.startsWith(`${contextId}\0`)) this.transcriptTextByKey.delete(key);
    }
    for (let i = this.transcriptSequence.length - 1; i >= 0; i -= 1) {
      if (this.transcriptSequence[i]?.contextId === contextId) {
        this.transcriptSequence.splice(i, 1);
      }
    }
  }

  private clearUserTranscriptAccumulation(contextId: string): void {
    const prefix = `${contextId}\0`;
    for (const key of [...this.userCommittedByKey.keys()]) {
      if (key.startsWith(prefix)) this.userCommittedByKey.delete(key);
    }
    for (const key of [...this.userLiveByKey.keys()]) {
      if (key.startsWith(prefix)) this.userLiveByKey.delete(key);
    }
    for (const key of [...this.userPendingFinalByKey.keys()]) {
      if (key.startsWith(prefix)) this.userPendingFinalByKey.delete(key);
    }
  }

  private appendUserCommitted(key: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const committed = this.userCommittedByKey.get(key) ?? "";
    if (committed === trimmed || committed.endsWith(` ${trimmed}`) || committed.endsWith(trimmed)) return;
    this.userCommittedByKey.set(key, committed ? `${committed} ${trimmed}` : trimmed);
  }

  private isDuplicateUserFinal(key: string, text: string): boolean {
    const live = this.userLiveByKey.get(key) ?? "";
    if (live === text) return true;
    const committed = this.userCommittedByKey.get(key) ?? "";
    const trimmed = text.trim();
    if (!live && trimmed && (committed === trimmed || committed.endsWith(` ${trimmed}`))) return true;
    return false;
  }

  private syncUserTranscriptDisplay(key: string): void {
    const committed = this.userCommittedByKey.get(key) ?? "";
    const live = this.userLiveByKey.get(key) ?? "";
    this.transcriptTextByKey.set(key, live ? (committed ? `${committed} ${live}` : live) : committed);
  }

}
