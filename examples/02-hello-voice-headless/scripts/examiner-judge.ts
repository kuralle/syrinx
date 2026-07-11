// SPDX-License-Identifier: MIT
//
// Post-hoc LLM judge for full-duplex examiner turns (Full-Duplex-Bench-v2 style).
// Scores turn-taking fluency + instruction-following against the active sub-goal.
// Never re-drives audio — judges captured transcript metrics only.

import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

export const DEFAULT_TOR_THRESHOLD_MS = 400;

export const JUDGE_SCORE_SCHEMA = z.object({
  turnTakingFluency: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("1=interruptive/awkward turn-taking, 5=natural and well-timed"),
  instructionFollowing: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("1=ignored the user goal, 5=fully addressed the sub-goal"),
  addressedGoal: z
    .boolean()
    .describe("True only if the reply substantively addresses the current sub-goal (not filler)"),
  note: z.string().describe("One short sentence justifying the scores"),
});

export type JudgeScore = z.infer<typeof JUDGE_SCORE_SCHEMA>;

export interface JudgeTurnInput {
  readonly subGoal: string;
  readonly examinerUtterance: string;
  readonly agentReply: string;
  readonly responseLatencyMs: number;
}

export interface TurnJudgeResult extends JudgeScore {
  readonly turn: number;
  readonly takeover: boolean;
}

export interface FdeJudgedAggregates {
  readonly medianTurnTakingFluency: number;
  readonly medianInstructionFollowing: number;
  readonly addressedGoalRate: number;
  readonly takeoverRate: number;
}

export interface FdeJudgedResult {
  readonly turns: readonly TurnJudgeResult[];
  readonly aggregates: FdeJudgedAggregates;
  readonly torThresholdMs: number;
  readonly stub: boolean;
}

export function resolveJudgeModel(): string {
  return process.env["SYRINX_JUDGE_MODEL"]?.trim() || "gpt-4o-mini";
}

export function resolveTorThresholdMs(): number {
  const raw = process.env["SYRINX_FDE_TOR_THRESHOLD_MS"]?.trim();
  if (!raw) return DEFAULT_TOR_THRESHOLD_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOR_THRESHOLD_MS;
}

/** True when latency is below the natural-pause threshold (eager takeover). */
export function isTakeover(responseLatencyMs: number, torThresholdMs = DEFAULT_TOR_THRESHOLD_MS): boolean {
  return responseLatencyMs < torThresholdMs;
}

export function computeTakeoverRate(
  latenciesMs: readonly number[],
  torThresholdMs = DEFAULT_TOR_THRESHOLD_MS,
): number {
  if (latenciesMs.length === 0) return 0;
  const takeovers = latenciesMs.filter((ms) => isTakeover(ms, torThresholdMs)).length;
  return takeovers / latenciesMs.length;
}

const FILLER_RE =
  /\b(are you still there|still there|one moment|hold on|let me (check|see|look)|just a (sec|second|moment)|please hold)\b/i;

/**
 * Deterministic stub judge for dry mode — no providers.
 * Heuristic over canned replies: short filler-like text scores low; substantive replies score high.
 */
export function stubJudgeTurn(input: JudgeTurnInput): JudgeScore {
  const reply = input.agentReply.trim();
  const empty = reply.length === 0;
  const filler = !empty && (FILLER_RE.test(reply) || reply.length < 24);
  const addressedGoal = !empty && !filler;

  let turnTakingFluency: number;
  if (input.responseLatencyMs < 0) turnTakingFluency = 1;
  else if (input.responseLatencyMs < DEFAULT_TOR_THRESHOLD_MS) turnTakingFluency = 2;
  else if (input.responseLatencyMs < 2_000) turnTakingFluency = 4;
  else if (input.responseLatencyMs < 5_000) turnTakingFluency = 3;
  else turnTakingFluency = 2;

  if (filler) turnTakingFluency = Math.min(turnTakingFluency, 2);
  if (empty) turnTakingFluency = 1;

  const instructionFollowing = empty ? 1 : filler ? 1 : 4;

  return {
    turnTakingFluency,
    instructionFollowing,
    addressedGoal,
    note: empty
      ? "stub: empty agent reply"
      : filler
        ? "stub: filler or non-substantive reply"
        : "stub: substantive reply addressing the turn",
  };
}

export async function judgeTurn(input: JudgeTurnInput): Promise<JudgeScore> {
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY required for live judge");

  const modelId = resolveJudgeModel();
  const model = createOpenAI({
    apiKey,
    baseURL: process.env["OPENAI_BASE_URL"]?.trim() || undefined,
  })(modelId);

  const system = [
    "You are an impartial judge of full-duplex voice-agent turn quality.",
    "Score ONLY the agent's spoken reply relative to the examiner's current sub-goal and utterance.",
    "Turn-taking fluency (1-5): how naturally and promptly the agent took its turn.",
    "  Low if the agent interrupted, left an awkward gap, or emitted impatient filler that does not help.",
    "Instruction-following (1-5): whether the reply actually advances the sub-goal.",
    "addressedGoal: false for pure fillers (e.g. \"Are you still there?\") that never answer the user.",
    "Be strict: a polite stall without content is not instruction-following.",
    `Measured response latency was ${input.responseLatencyMs}ms (time to first agent audio after user speech end).`,
  ].join("\n");

  const prompt = [
    `Current sub-goal: ${input.subGoal}`,
    `Examiner (user) said: "${input.examinerUtterance}"`,
    `Agent replied: "${input.agentReply || "(no text captured)"}"`,
    `Response latency (ms): ${input.responseLatencyMs}`,
    "",
    "Score this turn.",
  ].join("\n");

  const result = await generateObject({
    model,
    schema: JUDGE_SCORE_SCHEMA,
    system,
    prompt,
    temperature: 0,
    maxOutputTokens: 200,
  });

  return result.object;
}

export async function judgeCapturedTurns(params: {
  readonly turns: readonly {
    readonly turn: number;
    readonly utteranceText: string;
    readonly agentReply: string;
    readonly responseLatencyMs: number;
    readonly subGoal: string;
  }[];
  readonly dry: boolean;
  readonly torThresholdMs?: number;
}): Promise<FdeJudgedResult> {
  const torThresholdMs = params.torThresholdMs ?? resolveTorThresholdMs();
  const results: TurnJudgeResult[] = [];

  for (const t of params.turns) {
    const input: JudgeTurnInput = {
      subGoal: t.subGoal,
      examinerUtterance: t.utteranceText,
      agentReply: t.agentReply,
      responseLatencyMs: t.responseLatencyMs,
    };
    const score = params.dry ? stubJudgeTurn(input) : await judgeTurn(input);
    results.push({
      turn: t.turn,
      ...score,
      takeover: isTakeover(t.responseLatencyMs, torThresholdMs),
    });
  }

  return {
    turns: results,
    aggregates: aggregateJudgeScores(results),
    torThresholdMs,
    stub: params.dry,
  };
}

export function aggregateJudgeScores(turns: readonly TurnJudgeResult[]): FdeJudgedAggregates {
  if (turns.length === 0) {
    return {
      medianTurnTakingFluency: 0,
      medianInstructionFollowing: 0,
      addressedGoalRate: 0,
      takeoverRate: 0,
    };
  }
  const fluency = turns.map((t) => t.turnTakingFluency);
  const following = turns.map((t) => t.instructionFollowing);
  const addressed = turns.filter((t) => t.addressedGoal).length;
  const takeovers = turns.filter((t) => t.takeover).length;
  return {
    medianTurnTakingFluency: median(fluency),
    medianInstructionFollowing: median(following),
    addressedGoalRate: addressed / turns.length,
    takeoverRate: takeovers / turns.length,
  };
}

export function renderJudgedTable(judged: FdeJudgedResult): string {
  const header =
    "| Turn | Fluency | Instruction | Addressed | Takeover | Note |";
  const sep = "|---|---|---|---|---|---|";
  const body = judged.turns.map((t) => {
    const note = t.note.length > 48 ? `${t.note.slice(0, 45)}...` : t.note;
    return `| ${t.turn} | ${t.turnTakingFluency} | ${t.instructionFollowing} | ${t.addressedGoal ? "yes" : "no"} | ${t.takeover ? "yes" : "no"} | ${note} |`;
  });
  const agg = judged.aggregates;
  const summary = [
    "",
    `Judged aggregates (torThreshold=${judged.torThresholdMs}ms, stub=${judged.stub}):`,
    `  median turnTakingFluency: ${agg.medianTurnTakingFluency}`,
    `  median instructionFollowing: ${agg.medianInstructionFollowing}`,
    `  addressedGoalRate: ${formatRate(agg.addressedGoalRate)}`,
    `  takeoverRate (TOR): ${formatRate(agg.takeoverRate)}`,
  ].join("\n");
  return [header, sep, ...body, summary].join("\n");
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
