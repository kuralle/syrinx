// SPDX-License-Identifier: MIT
//
// IP-C6: locks the RFC §9.4 verdict rule + table rendering for the InteractionPolicy eval matrix.

import { describe, it, expect } from "vitest";
import {
  CONFIG_MATRIX,
  thesisVerdict,
  renderMatrixTable,
  type MatrixRow,
} from "../scripts/interaction-config-sweep.js";

describe("CONFIG_MATRIX", () => {
  it("gates the VAP configs (need wiring + a real model) and leaves cascade+rules runnable", () => {
    const byId = new Map(CONFIG_MATRIX.map((c) => [c.id, c]));
    expect(byId.get("cascade+rules")?.gatedReason).toBeUndefined();
    expect(byId.get("cascade+VAP")?.gatedReason).toBeTruthy();
    expect(byId.get("cascade+VAP+rich-seam")?.gatedReason).toBeTruthy();
  });
});

describe("thesisVerdict (RFC §9.4)", () => {
  it("is not proven while the VAP or native rows are gated/absent", () => {
    const rows: MatrixRow[] = [{ config: "cascade+rules", gated: false, taskSuccessRate: 1 }];
    expect(thesisVerdict(rows).proven).toBe(false);
  });

  it("is proven when cascade+VAP matches native turn-taking with no task-success regression", () => {
    const rows: MatrixRow[] = [
      {
        config: "cascade+VAP+rich-seam",
        gated: false,
        turnTaking: { turnTakingTimingScore: 82, overlapScore: 100, avgResponseLatencyMs: 900 },
        taskSuccessRate: 0.9,
      },
      {
        config: "native-realtime",
        gated: false,
        turnTaking: { turnTakingTimingScore: 84, overlapScore: 100, avgResponseLatencyMs: 700 },
        taskSuccessRate: 0.9,
      },
    ];
    expect(thesisVerdict(rows).proven).toBe(true);
  });

  it("is NOT proven when task success regresses even if turn-taking matches", () => {
    const rows: MatrixRow[] = [
      {
        config: "cascade+VAP+rich-seam",
        gated: false,
        turnTaking: { turnTakingTimingScore: 84, overlapScore: 100, avgResponseLatencyMs: 900 },
        taskSuccessRate: 0.7,
      },
      {
        config: "native-realtime",
        gated: false,
        turnTaking: { turnTakingTimingScore: 84, overlapScore: 100, avgResponseLatencyMs: 700 },
        taskSuccessRate: 0.9,
      },
    ];
    expect(thesisVerdict(rows).proven).toBe(false);
  });
});

describe("renderMatrixTable", () => {
  it("renders a row per config with — for missing metrics and GATED for gated configs", () => {
    const out = renderMatrixTable([
      { config: "cascade+rules", gated: false, taskSuccessRate: 1 },
      { config: "cascade+VAP", gated: true },
    ]);
    expect(out).toContain("| config |");
    expect(out).toContain("cascade+rules");
    expect(out).toContain("GATED");
    expect(out).toContain("1.00");
  });
});
