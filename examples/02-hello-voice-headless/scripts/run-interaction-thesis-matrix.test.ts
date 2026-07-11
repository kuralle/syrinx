// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  buildMatrixRows,
  computeTaskSuccessRate,
  isDryMode,
  runDryMatrix,
  syntheticDryTurnCaptures,
  turnTaskSucceeded,
} from "./run-interaction-thesis-matrix.js";
import { thesisVerdict } from "./interaction-config-sweep.js";

describe("run-interaction-thesis-matrix dry structural path", () => {
  it("detects --dry and SYRINX_THESIS_DRY=1", () => {
    expect(isDryMode(["node", "script", "--dry"])).toBe(true);
    const prev = process.env["SYRINX_THESIS_DRY"];
    process.env["SYRINX_THESIS_DRY"] = "1";
    try {
      expect(isDryMode(["node", "script"])).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["SYRINX_THESIS_DRY"];
      else process.env["SYRINX_THESIS_DRY"] = prev;
    }
  });

  it("scores task success from tool call + grounded reply", () => {
    const ok = syntheticDryTurnCaptures("cascade")[0]!;
    expect(turnTaskSucceeded(ok)).toBe(true);
    expect(turnTaskSucceeded({ ...ok, toolCalled: false })).toBe(false);
    expect(turnTaskSucceeded({ ...ok, agentReply: "" })).toBe(false);
    expect(computeTaskSuccessRate(syntheticDryTurnCaptures("native"))).toBe(1);
  });

  it("builds a 2-row matrix and cascade+rules thesis verdict without providers", () => {
    const cascadeTurns = syntheticDryTurnCaptures("cascade");
    const nativeTurns = syntheticDryTurnCaptures("native");
    const rows = buildMatrixRows(cascadeTurns, nativeTurns);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.config).toBe("cascade+rules");
    expect(rows[1]?.config).toBe("native-realtime");
    expect(rows[0]?.turnTaking?.turnTakingTimingScore).toBeGreaterThan(0);
    expect(rows[1]?.taskSuccessRate).toBe(1);

    const verdict = thesisVerdict(rows, { cascadeConfig: "cascade+rules" });
    expect(verdict.proven).toBe(true);

    const dry = runDryMatrix();
    expect(dry.dry).toBe(true);
    expect(dry.rows).toHaveLength(2);
    expect(dry.verdict.proven).toBe(true);
    expect(dry.turns.cascadeRules).toHaveLength(3);
    expect(dry.turns.nativeRealtime).toHaveLength(3);
  });
});