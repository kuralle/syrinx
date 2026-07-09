// SPDX-License-Identifier: MIT
//
// IP-C6: task-success scoring for the InteractionPolicy eval matrix (RFC §9.4).
// A voice adaptation of tau-bench / tau^2-bench: multi-turn tool-use tasks scored by a
// deterministic domain rule, so a config's turn-taking gains can be checked NOT to come
// at the cost of task success. This module is pure + deterministic (no providers) so it
// is unit-tested; the live config sweep (interaction-config-sweep.ts) feeds it real traces.

export interface ToolCallTrace {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** What one task turn actually did: the tools it called and the final spoken text. */
export interface TaskTrace {
  readonly toolCalls: readonly ToolCallTrace[];
  readonly finalText: string;
}

export interface VoiceTaskSpec {
  readonly id: string;
  /** The user request driving the task (used by the live runner; ignored by the scorer). */
  readonly prompt: string;
  /** Tools that MUST be called (by name) for the task to be satisfiable. */
  readonly requiredTools: readonly string[];
  /** Domain rule over the trace — the ground-truth success check. */
  readonly successRule: (trace: TaskTrace) => boolean;
}

export interface TaskResult {
  readonly id: string;
  readonly success: boolean;
  readonly reasons: readonly string[];
}

/** Score one task trace against its spec: all required tools called AND the domain rule holds. */
export function scoreTask(spec: VoiceTaskSpec, trace: TaskTrace): TaskResult {
  const reasons: string[] = [];
  const called = new Set(trace.toolCalls.map((c) => c.name));
  for (const tool of spec.requiredTools) {
    if (!called.has(tool)) reasons.push(`missing required tool: ${tool}`);
  }
  let ruleOk = false;
  try {
    ruleOk = spec.successRule(trace);
  } catch (err) {
    reasons.push(`success rule threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!ruleOk) reasons.push("domain success rule not satisfied");
  return { id: spec.id, success: reasons.length === 0, reasons };
}

/** Fraction of tasks that succeeded (0..1). Empty set → NaN (no tasks run). */
export function taskSuccessRate(results: readonly TaskResult[]): number {
  if (results.length === 0) return Number.NaN;
  return results.filter((r) => r.success).length / results.length;
}

function mentionsAll(text: string, needles: readonly string[]): boolean {
  const hay = text.toLowerCase();
  return needles.every((n) => hay.includes(n.toLowerCase()));
}

/**
 * A small, deterministic university-support task set (mirrors the example agent's domain +
 * the eva-bench examiner scenario). Grow toward a fuller voice tau-bench later. The rules are
 * intentionally strict-but-checkable: the tool was consulted AND the spoken answer reflects it.
 */
export const DEFAULT_VOICE_TASKS: readonly VoiceTaskSpec[] = [
  {
    id: "cs-masters-documents",
    prompt: "I'm applying for the CS masters — what documents do I need?",
    requiredTools: ["consult_knowledge"],
    successRule: (t) => mentionsAll(t.finalText, ["transcript"]),
  },
  {
    id: "application-deadline",
    prompt: "When is the application deadline?",
    requiredTools: ["consult_knowledge"],
    successRule: (t) =>
      t.toolCalls.some(
        (c) => c.name === "consult_knowledge" && /deadline|date/i.test(String(c.args["query"] ?? "")),
      ) && /\d/.test(t.finalText),
  },
  {
    id: "tuition-fee",
    prompt: "How much is the tuition fee?",
    requiredTools: ["consult_knowledge"],
    successRule: (t) => mentionsAll(t.finalText, ["fee"]) && /\d/.test(t.finalText),
  },
];
