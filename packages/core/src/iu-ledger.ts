// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Incremental-Unit ledger (IU substrate, RFC incremental-unit-substrate)

import type { IncrementalUnit, IncrementalUnitId, IuState } from "./incremental-unit.js";

export interface IuLedger {
  add(iu: IncrementalUnit): void;
  commit(id: IncrementalUnitId, prefix?: { chars?: number; ms?: number }): void;
  revoke(id: IncrementalUnitId): void;
  get(id: IncrementalUnitId): IncrementalUnit | undefined;
  latest(contextId: string, kind: IncrementalUnit["kind"]): IncrementalUnit | undefined;
  clear(contextId: string): void;
}

export type IuLedgerAnomaly =
  | { readonly kind: "terminal_op"; readonly op: "commit" | "revoke"; readonly id: IncrementalUnitId; readonly state: IuState }
  | { readonly kind: "unknown_iu"; readonly op: "commit" | "revoke"; readonly id: IncrementalUnitId };

export class InMemoryIuLedger implements IuLedger {
  private readonly byCtx = new Map<string, Map<string, IncrementalUnit>>();

  constructor(
    private readonly onEvent: (a: IuLedgerAnomaly) => void = () => {},
    private readonly maxContexts: number = 256,
  ) {}

  add(iu: IncrementalUnit): void {
    const ctx = iu.id.contextId;
    if (!this.byCtx.has(ctx) && this.byCtx.size >= this.maxContexts) {
      const oldest = this.byCtx.keys().next().value;
      if (oldest !== undefined) this.byCtx.delete(oldest);
    }
    this.ctxMap(ctx).set(iu.id.iuId, iu);
  }

  commit(id: IncrementalUnitId, prefix?: { chars?: number; ms?: number }): void {
    const ctxMap = this.byCtx.get(id.contextId);
    if (!ctxMap) {
      this.onEvent({ kind: "unknown_iu", op: "commit", id });
      return;
    }
    const iu = ctxMap.get(id.iuId);
    if (!iu) {
      this.onEvent({ kind: "unknown_iu", op: "commit", id });
      return;
    }
    if (iu.state !== "hypothesized") {
      this.onEvent({ kind: "terminal_op", op: "commit", id, state: iu.state });
      return;
    }
    iu.state = "committed";
    if (prefix) {
      iu.committedPrefix = prefix;
    }
  }

  revoke(id: IncrementalUnitId): void {
    const ctxMap = this.byCtx.get(id.contextId);
    if (!ctxMap) {
      this.onEvent({ kind: "unknown_iu", op: "revoke", id });
      return;
    }
    const iu = ctxMap.get(id.iuId);
    if (!iu) {
      this.onEvent({ kind: "unknown_iu", op: "revoke", id });
      return;
    }
    if (iu.state !== "hypothesized") {
      this.onEvent({ kind: "terminal_op", op: "revoke", id, state: iu.state });
      return;
    }
    iu.state = "revoked";
  }

  get(id: IncrementalUnitId): IncrementalUnit | undefined {
    const ctxMap = this.byCtx.get(id.contextId);
    if (!ctxMap) {
      return undefined;
    }
    return ctxMap.get(id.iuId);
  }

  latest(contextId: string, kind: IncrementalUnit["kind"]): IncrementalUnit | undefined {
    const ctxMap = this.byCtx.get(contextId);
    if (!ctxMap) {
      return undefined;
    }
    let found: IncrementalUnit | undefined;
    for (const iu of ctxMap.values()) {
      if (iu.kind === kind) {
        found = iu;
      }
    }
    return found;
  }

  clear(contextId: string): void {
    this.byCtx.delete(contextId);
  }

  private ctxMap(contextId: string): Map<string, IncrementalUnit> {
    let map = this.byCtx.get(contextId);
    if (!map) {
      map = new Map();
      this.byCtx.set(contextId, map);
    }
    return map;
  }
}