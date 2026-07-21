// SPDX-License-Identifier: MIT
//
// Pure spend accumulator + policy. Observe (record) and control (check) are
// separated so the same usage packet is never double-counted by the guard.

import type { UsageRecordedPacket } from "./packets.js";
import { costOf, DEFAULT_PRICE_CATALOG, type PriceCatalog } from "./pricing.js";

export interface SpendCapConfig {
  readonly maxUsd: number;
  readonly catalog?: PriceCatalog;
}

export interface SpendCapCheck {
  readonly exceeded: boolean;
  readonly spentUsd: number;
}

/**
 * Accumulates priced `usage.recorded` into session spend and reports whether a
 * configured USD cap has been breached. Does not call providers; the session
 * layer decides refuse/fallback from `check()`.
 */
export class SpendCapGuard {
  private readonly maxUsd: number;
  private readonly catalog: PriceCatalog;
  private spentUsd = 0;
  private exceeded = false;

  constructor(cfg: SpendCapConfig) {
    if (!Number.isFinite(cfg.maxUsd) || cfg.maxUsd < 0) {
      throw new Error(`SpendCapGuard maxUsd must be a non-negative finite number, got ${String(cfg.maxUsd)}`);
    }
    this.maxUsd = cfg.maxUsd;
    this.catalog = cfg.catalog ?? DEFAULT_PRICE_CATALOG;
  }

  /** Observe one usage packet. Unpriced usage does not change spentUsd. */
  record(usage: UsageRecordedPacket): void {
    const result = costOf(usage, this.catalog);
    if (result.usd === null) return;
    this.spentUsd += result.usd;
    if (this.spentUsd > this.maxUsd) {
      this.exceeded = true;
    }
  }

  /** Read-only policy view — never mutates spend. */
  check(): SpendCapCheck {
    return { exceeded: this.exceeded, spentUsd: this.spentUsd };
  }
}
