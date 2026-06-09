// SPDX-License-Identifier: MIT

import { pathToFileURL } from "node:url";


import { ensureRepoRootDotenv } from "../src/run-one-turn.js";
import { createFullUniversityRuntime } from "../src/university-agent-full.js";


const SESSION_ID = "kuralle-full-text-smoke";
const USER_ID = "priya";

interface TurnSpec {
  readonly label: string;
  readonly input: string;
  readonly hardAssert?: (reply: string, ctx: TurnContext) => string | null;
  readonly softAssert?: (reply: string, ctx: TurnContext) => string | null;
}

interface TurnContext {
  readonly flowEnters: string[];
  readonly knowledgeSearches: Array<{ latencyMs: number; resultCount: number }>;
  readonly toolCalls: string[];
}

interface TurnResult extends TurnContext {
  readonly label: string;
  readonly input: string;
  readonly reply: string;
  readonly ttftMs: number;
  readonly totalMs: number;
  readonly mode: "flow" | "keep";
  readonly partTrace: string[];
}

interface StreamPart {
  readonly type: string;
  readonly delta?: string;
  readonly flow?: string;
  readonly latencyMs?: number;
  readonly resultCount?: number;
  readonly toolName?: string;
}

async function runTurn(
  runtime: Awaited<ReturnType<typeof createFullUniversityRuntime>>["runtime"],
  spec: TurnSpec,
): Promise<TurnResult> {
  const t0 = performance.now();
  const handle = runtime.run({ input: spec.input, sessionId: SESSION_ID, userId: USER_ID });

  const partTrace: string[] = [];
  const flowEnters: string[] = [];
  const knowledgeSearches: Array<{ latencyMs: number; resultCount: number }> = [];
  const toolCalls: string[] = [];
  let reply = "";
  let ttftMs = 0;
  let textDeltaCount = 0;
  let firstTextDeltaLogged = false;

  for await (const raw of handle.events) {
    const part = raw as StreamPart;
    const elapsed = performance.now() - t0;

    if (part.type === "text-delta") {
      textDeltaCount += 1;
      if (ttftMs === 0) ttftMs = elapsed;
      reply += part.delta ?? "";
      if (!firstTextDeltaLogged) {
        partTrace.push(`+${Math.round(elapsed)}ms text-delta`);
        firstTextDeltaLogged = true;
      }
      continue;
    }

    if (textDeltaCount > 1 && firstTextDeltaLogged) {
      partTrace.push(`+${Math.round(elapsed)}ms text-delta x${textDeltaCount} (collapsed)`);
      textDeltaCount = 0;
      firstTextDeltaLogged = false;
    } else if (textDeltaCount === 1 && firstTextDeltaLogged) {
      textDeltaCount = 0;
      firstTextDeltaLogged = false;
    }

    partTrace.push(`+${Math.round(elapsed)}ms ${part.type}`);

    if (part.type === "flow-enter" && part.flow) flowEnters.push(part.flow);
    if (part.type === "knowledge-search") {
      knowledgeSearches.push({
        latencyMs: part.latencyMs ?? 0,
        resultCount: part.resultCount ?? 0,
      });
    }
    if (part.type === "tool-call" && part.toolName) toolCalls.push(part.toolName);
  }

  if (textDeltaCount > 1) {
    partTrace.push(`text-delta x${textDeltaCount} (collapsed)`);
  }

  await handle;

  const totalMs = performance.now() - t0;
  const mode: "flow" | "keep" = flowEnters.length > 0 ? "flow" : "keep";

  return {
    label: spec.label,
    input: spec.input,
    reply,
    ttftMs,
    totalMs,
    mode,
    partTrace,
    flowEnters,
    knowledgeSearches,
    toolCalls,
  };
}

function printTurnBlock(result: TurnResult): void {
  console.log(`\n=== ${result.label} ===`);
  console.log(`input: ${result.input}`);
  console.log(`mode: ${result.mode}${result.flowEnters.length > 0 ? ` (${result.flowEnters.join(", ")})` : ""}`);
  for (const line of result.partTrace) console.log(`  ${line}`);
  if (result.knowledgeSearches.length > 0) {
    for (const ks of result.knowledgeSearches) {
      console.log(`  knowledge-search: latencyMs=${ks.latencyMs} resultCount=${ks.resultCount}`);
    }
  }
  if (result.toolCalls.length > 0) console.log(`  tool-calls: ${result.toolCalls.join(", ")}`);
  console.log(`reply: ${result.reply}`);
  console.log(`TTFT: ${Math.round(result.ttftMs)}ms  total: ${Math.round(result.totalMs)}ms`);
}

function containsDeadline(text: string): boolean {
  return text.toLowerCase().includes("march 31");
}

function containsScholarshipDeadline(text: string): boolean {
  const lower = text.toLowerCase();
  return (lower.includes("february 15") || lower.includes("feb 15")) &&
    (lower.includes("scholarship") || lower.includes("merit") || lower.includes("grant") || lower.includes("fafsa"));
}

function asksToConfirm(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("confirm") || lower.includes("is that correct") || lower.includes("does that look");
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  if (!process.env["OPENAI_API_KEY"]?.trim()) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const { runtime, ingestMs } = await createFullUniversityRuntime();
  console.log(`ingestMs: ${Math.round(ingestMs)}`);

  const turns: TurnSpec[] = [
    {
      label: "T1",
      input: "What's the application deadline for the computer science masters?",
      hardAssert: (reply) => (containsDeadline(reply) ? null : 'expected "March 31" in reply'),
    },
    {
      label: "T2",
      input: "I might need financial help. What scholarships can I get and what's the deadline?",
      softAssert: (reply) =>
        containsScholarshipDeadline(reply) ? null : "expected scholarship mention and Feb 15 deadline",
    },
    {
      label: "T3",
      input: "I'd like to book an appointment with an advisor.",
      softAssert: (reply, ctx) => {
        const enteredBooking = ctx.flowEnters.includes("book-advisor-appointment");
        const asksFields =
          reply.toLowerCase().includes("name") &&
          (reply.toLowerCase().includes("program") || reply.toLowerCase().includes("date"));
        if (enteredBooking || asksFields) return null;
        return "expected flow-enter book-advisor-appointment or ask for name/program/date";
      },
    },
    {
      label: "T4",
      input: "I'm Priya, computer science masters, this Friday.",
      softAssert: (reply) => (asksToConfirm(reply) ? null : "expected confirmGate confirmation prompt"),
    },
    {
      label: "T5",
      input: "Yes, that's correct.",
      hardAssert: (reply) => (reply.includes("ADV-") ? null : 'expected "ADV-" booking reference'),
    },
    {
      label: "T6",
      input: "Can I also request my transcript? My student ID is S12345.",
      hardAssert: (reply) => (reply.includes("TR-S12345") ? null : 'expected "TR-S12345" transcript reference'),
    },
  ];

  const results: TurnResult[] = [];
  const hardFailures: string[] = [];
  const softWarnings: string[] = [];

  for (const spec of turns) {
    const result = await runTurn(runtime, spec);
    results.push(result);
    printTurnBlock(result);

    const ctx: TurnContext = {
      flowEnters: result.flowEnters,
      knowledgeSearches: result.knowledgeSearches,
      toolCalls: result.toolCalls,
    };

    if (spec.hardAssert) {
      const fail = spec.hardAssert(result.reply, ctx);
      if (fail) {
        hardFailures.push(`${spec.label}: ${fail}`);
        console.log(`FAIL (hard): ${fail}`);
      } else {
        console.log(`PASS (hard)`);
      }
    }

    if (spec.softAssert) {
      const warn = spec.softAssert(result.reply, ctx);
      if (warn) {
        softWarnings.push(`${spec.label}: ${warn}`);
        console.log(`WARN (soft): ${warn}`);
      } else {
        console.log(`PASS (soft)`);
      }
    }
  }

  if (!results[5]?.reply.includes("TR-S12345")) {
    const t7 = await runTurn(runtime, {
      label: "T7",
      input: "yes",
      hardAssert: (reply) => (reply.includes("TR-S12345") ? null : 'expected "TR-S12345" after confirmation'),
    });
    results.push(t7);
    printTurnBlock(t7);
    const fail = t7.reply.includes("TR-S12345") ? null : 'expected "TR-S12345" after confirmation';
    if (fail) {
      hardFailures.push(`T7: ${fail}`);
      console.log(`FAIL (hard): ${fail}`);
    } else {
      console.log(`PASS (hard)`);
    }
  }

  console.log("\n=== Latency Table ===");
  console.log("turn | mode   | TTFT(ms) | total(ms) | knowledge-search(ms) | flow");
  for (const r of results) {
    const ks = r.knowledgeSearches.map((k) => String(k.latencyMs)).join(";") || "-";
    const flow = r.flowEnters.join(";") || "-";
    console.log(
      `${r.label.padEnd(4)} | ${r.mode.padEnd(6)} | ${String(Math.round(r.ttftMs)).padStart(8)} | ${String(Math.round(r.totalMs)).padStart(9)} | ${ks.padStart(20)} | ${flow}`,
    );
  }

  console.log("\n=== Summary ===");
  if (softWarnings.length > 0) {
    for (const w of softWarnings) console.log(`WARN: ${w}`);
  }
  if (hardFailures.length > 0) {
    for (const f of hardFailures) console.log(`FAIL: ${f}`);
    process.exit(1);
  }
  console.log("ALL HARD ASSERTIONS PASSED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
