// SPDX-License-Identifier: MIT
//
// IP-C6: the InteractionPolicy eval matrix (RFC §9.4 proof gate). One command produces a
// per-config table of turn-taking quality × task success, so the decoupled thesis is declared
// proven only when `cascade+VAP+rich-seam` matches `native-realtime` on turn-taking WITHOUT a
// task-success regression.
//
// Turn-taking metrics REUSE the shipped Full-Duplex-Bench scorer (eva-evaluator.ts, VE-05):
// `evaluateEvaExaminer` / `compareEvaToBaseline`. Task success uses the new scorer (task-success.ts).
//
// Status: the harness + scorers + verdict rule are complete and unit-tested. Session policy injection,
// stateful DualTurn ONNX, Kyoto VAP, and the rich STT fusion arm are available. The reproducible model
// frontier runs on Modal via `scripts/modal/run_c6_eot_eval.py`; this local command remains the
// provider-free task-success and table-contract self-check.
//
// Run: `pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:interaction-eval-matrix`
// (dry self-check: deterministic task-success over the default set + the table skeleton; no providers).

import type { EvaExaminerScores } from "./eva-evaluator.js";
import {
  DEFAULT_VOICE_TASKS,
  scoreTask,
  taskSuccessRate,
  type TaskTrace,
} from "./task-success.js";

export type ConfigId =
  | "cascade+rules"
  | "cascade+VAP"
  | "cascade+VAP+rich-seam"
  | "native-realtime"
  | "realtime+delegate";

export interface ConfigSpec {
  readonly id: ConfigId;
  /** Runnable now, or gated (with the reason) until a prerequisite lands. */
  readonly gatedReason?: string;
}

export const CONFIG_MATRIX: readonly ConfigSpec[] = [
  { id: "cascade+rules" },
  { id: "cascade+VAP" },
  { id: "cascade+VAP+rich-seam" },
  { id: "native-realtime" },
  { id: "realtime+delegate" },
];

export interface MatrixRow {
  readonly config: ConfigId;
  readonly gated: boolean;
  readonly turnTaking?: Pick<EvaExaminerScores, "turnTakingTimingScore" | "overlapScore" | "avgResponseLatencyMs">;
  readonly taskSuccessRate?: number;
  readonly note?: string;
}

/** RFC §9.4 verdict: proven iff cascade+VAP+rich-seam matches native-realtime on turn-taking
 *  (within a small delta) WITHOUT a task-success regression. Returns a human verdict + whether the
 *  inputs were even present (unproven when the gated configs have not been run). */
export function thesisVerdict(rows: readonly MatrixRow[], timingDelta = 5): {
  proven: boolean;
  reason: string;
} {
  const vap = rows.find((r) => r.config === "cascade+VAP+rich-seam");
  const native = rows.find((r) => r.config === "native-realtime");
  if (!vap?.turnTaking || !native?.turnTaking) {
    return { proven: false, reason: "not yet measurable — cascade+VAP+rich-seam or native-realtime metrics were not provided" };
  }
  const timingOk = vap.turnTaking.turnTakingTimingScore >= native.turnTaking.turnTakingTimingScore - timingDelta;
  const taskOk =
    vap.taskSuccessRate !== undefined &&
    native.taskSuccessRate !== undefined &&
    vap.taskSuccessRate >= native.taskSuccessRate - 1e-9;
  if (timingOk && taskOk) return { proven: true, reason: "cascade+VAP matches native turn-taking with no task-success regression" };
  return {
    proven: false,
    reason: `not proven — timing ${timingOk ? "ok" : "below native"}, task-success ${taskOk ? "ok" : "regressed"}`,
  };
}

export function renderMatrixTable(rows: readonly MatrixRow[]): string {
  const header = "| config | turn-taking | overlap | avg-latency(ms) | task-success | note |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const tt = r.turnTaking?.turnTakingTimingScore ?? "—";
    const ov = r.turnTaking?.overlapScore ?? "—";
    const lat = r.turnTaking?.avgResponseLatencyMs ?? "—";
    const ts = r.taskSuccessRate === undefined || Number.isNaN(r.taskSuccessRate) ? "—" : r.taskSuccessRate.toFixed(2);
    const note = r.note ?? (r.gated ? "GATED" : "");
    return `| ${r.config} | ${tt} | ${ov} | ${lat} | ${ts} | ${note} |`;
  });
  return [header, sep, ...body].join("\n");
}

// --- dry self-check (deterministic; no providers) -------------------------------------------------

function faithfulTraceFor(id: string): TaskTrace {
  const byId: Record<string, TaskTrace> = {
    "cs-masters-documents": {
      toolCalls: [{ name: "consult_knowledge", args: { query: "documents" } }],
      finalText: "You need your transcript and a statement of purpose.",
    },
    "application-deadline": {
      toolCalls: [{ name: "consult_knowledge", args: { query: "deadline" } }],
      finalText: "The application deadline is March 15.",
    },
    "tuition-fee": {
      toolCalls: [{ name: "consult_knowledge", args: { query: "fee" } }],
      finalText: "The tuition fee is 12000 per year.",
    },
  };
  return byId[id] ?? { toolCalls: [], finalText: "" };
}

function main(): void {
  // Deterministic self-check: score the default task set (proves the task-success half runs) and
  // print the matrix skeleton. Live turn-taking numbers come from the Modal C6 model frontier and
  // provider-backed examiner runs, neither of which is repeated by this provider-free self-check.
  const results = DEFAULT_VOICE_TASKS.map((spec) => scoreTask(spec, faithfulTraceFor(spec.id)));
  const cascadeRulesTaskRate = taskSuccessRate(results);

  const rows: MatrixRow[] = CONFIG_MATRIX.map((c) => {
    if (c.id === "cascade+rules") {
      return { config: c.id, gated: false, taskSuccessRate: cascadeRulesTaskRate, note: "task-success dry-checked; turn-taking pending live examiner" };
    }
    return { config: c.id, gated: c.gatedReason !== undefined, note: c.gatedReason };
  });

  const verdict = thesisVerdict(rows);
  // eslint-disable-next-line no-console
  console.log("# InteractionPolicy eval matrix (IP-C6)\n");
  // eslint-disable-next-line no-console
  console.log(renderMatrixTable(rows));
  // eslint-disable-next-line no-console
  console.log(`\nThesis verdict: ${verdict.proven ? "PROVEN" : "not proven"} — ${verdict.reason}`);
  // eslint-disable-next-line no-console
  console.log(`\ncascade+rules task-success (dry self-check): ${cascadeRulesTaskRate.toFixed(2)}`);
}

// Only run main() when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
