// SPDX-License-Identifier: MIT
//
// Argument parsing and verb dispatch. Never interactive: no prompts, no
// spinners, no colour unless the stream is a TTY. Results go to stdout,
// diagnostics to stderr — always, so --json output stays parseable.

import { parseArgs } from "node:util";

import { runDoctor } from "./doctor.js";
import { CliError, EXIT_CODES, EXIT_CODE_TABLE, type ExitCode } from "./exit-codes.js";
import { HELP_TEXT } from "./help.js";
import { runTextCommand } from "./text-command.js";
import { runTurnCommand } from "./turn-command.js";
import { CLI_VERSION, warnOnVersionSkew } from "./version.js";

export interface CliIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export const defaultIO: CliIO = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

function exitCodeName(code: ExitCode): string {
  return EXIT_CODE_TABLE.find((row) => row.code === code)?.name ?? "UNKNOWN";
}

/** Best-effort pre-parse scan so even a usage error can honour --json, without depending on parseArgs succeeding. */
function looksLikeJsonRequested(args: readonly string[]): boolean {
  return args.includes("--json");
}

function reportSuccess(io: CliIO, json: boolean, verb: string, payload: Record<string, unknown>, prose: string): ExitCode {
  if (json) {
    io.stdout(JSON.stringify({ ok: true, verb, ...payload }));
  } else {
    io.stdout(prose);
  }
  return EXIT_CODES.SUCCESS;
}

function reportError(io: CliIO, json: boolean, verb: string, err: unknown): ExitCode {
  const cliErr =
    err instanceof CliError ? err : new CliError(EXIT_CODES.INTERNAL, err instanceof Error ? err.message : String(err));
  if (cliErr.exitCode === EXIT_CODES.INTERNAL && err instanceof Error && err.stack) {
    io.stderr(err.stack);
  }
  if (json) {
    io.stdout(
      JSON.stringify({
        ok: false,
        verb,
        error: { code: exitCodeName(cliErr.exitCode), message: cliErr.message, ...(cliErr.details ?? {}) },
      }),
    );
  } else {
    io.stderr(`error: ${cliErr.message}`);
  }
  return cliErr.exitCode;
}

async function handleTurn(args: string[], io: CliIO): Promise<ExitCode> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        in: { type: "string" },
        agent: { type: "string" },
        "session-dir": { type: "string" },
        json: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return reportError(io, looksLikeJsonRequested(args), "turn", new CliError(EXIT_CODES.USAGE, err instanceof Error ? err.message : String(err)));
  }

  const json = values.json === true;
  if (!values.in) {
    return reportError(io, json, "turn", new CliError(EXIT_CODES.USAGE, "turn requires --in <fixture.wav|fixture.json>"));
  }
  if (!values.agent) {
    return reportError(
      io,
      json,
      "turn",
      new CliError(EXIT_CODES.USAGE, "turn requires --agent <module>#<export> — the CLI brings no providers of its own (see --help)"),
    );
  }

  try {
    const result = await runTurnCommand({
      inputPath: values.in,
      agentSpec: values.agent,
      sessionDir: values["session-dir"],
    });
    const prose = [
      `agent: ${result.agent}`,
      `transcript: ${result.transcript || "(empty)"}`,
      `reply: ${result.reply || "(empty)"}`,
      `session: ${result.sessionDir}`,
      result.assertion ? `assertion: match (expected "${result.assertion.expectedTranscript}")` : "assertion: none",
    ].join("\n");
    return reportSuccess(io, json, "turn", { ...result }, prose);
  } catch (err) {
    return reportError(io, json, "turn", err);
  }
}

async function handleText(args: string[], io: CliIO): Promise<ExitCode> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        agent: { type: "string" },
        json: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    return reportError(io, looksLikeJsonRequested(args), "text", new CliError(EXIT_CODES.USAGE, err instanceof Error ? err.message : String(err)));
  }

  const json = values.json === true;
  const message = positionals[0];
  if (!message) {
    return reportError(io, json, "text", new CliError(EXIT_CODES.USAGE, 'text requires a message: syrinx text "<message>" --agent <module>#<export>'));
  }
  if (!values.agent) {
    return reportError(
      io,
      json,
      "text",
      new CliError(EXIT_CODES.USAGE, "text requires --agent <module>#<export> — the CLI brings no providers of its own (see --help)"),
    );
  }

  try {
    const result = await runTextCommand({ message, agentSpec: values.agent });
    const prose = `agent: ${result.agent}\nreply: ${result.reply || "(empty)"}\nttft: ${String(result.ttftMs)}ms  total: ${String(result.totalMs)}ms`;
    return reportSuccess(io, json, "text", { ...result }, prose);
  } catch (err) {
    return reportError(io, json, "text", err);
  }
}

async function handleDoctor(args: string[], io: CliIO): Promise<ExitCode> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { agent: { type: "string" }, json: { type: "boolean", default: false } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return reportError(io, looksLikeJsonRequested(args), "doctor", new CliError(EXIT_CODES.USAGE, err instanceof Error ? err.message : String(err)));
  }

  const json = values.json === true;
  const report = await runDoctor({ agentSpec: values.agent });
  const prose = [
    `syrinx cli ${report.cliVersion}  node ${report.node.version} (${report.node.platform})`,
    `${report.core.package}: ${report.core.resolved ? `v${String(report.core.version)}` : "not installed"}${report.core.majorMismatch ? "  (major mismatch with CLI)" : ""}`,
    "well-known provider keys (informational only):",
    ...Object.entries(report.wellKnownProviderKeys).map(([key, present]) => `  ${key}: ${present ? "present" : "missing"}`),
    ...(report.agent ? [`agent (${report.agent.spec}): ${report.agent.resolved ? `resolved -> ${String(report.agent.label)}` : `NOT resolved (${String(report.agent.error)})`}`] : []),
    report.summary,
  ].join("\n");
  return reportSuccess(io, json, "doctor", { ...report }, prose);
}

export async function main(argv: readonly string[], io: CliIO = defaultIO): Promise<ExitCode> {
  try {
    warnOnVersionSkew(process.cwd());
  } catch {
    // Version-skew reporting is best-effort diagnostics; never let it block a command.
  }

  const [verb, ...rest] = argv;

  if (verb === undefined || verb === "--help" || verb === "-h") {
    io.stdout(HELP_TEXT);
    return EXIT_CODES.SUCCESS;
  }
  if (verb === "--version" || verb === "-v") {
    io.stdout(CLI_VERSION);
    return EXIT_CODES.SUCCESS;
  }

  switch (verb) {
    case "turn":
      return handleTurn(rest, io);
    case "text":
      return handleText(rest, io);
    case "doctor":
      return handleDoctor(rest, io);
    case "console":
    case "chat":
    case "listen":
      return reportError(
        io,
        looksLikeJsonRequested(rest),
        verb,
        new CliError(EXIT_CODES.USAGE, `"${verb}" is not a syrinx command — this CLI is non-interactive by design (see --help). Use the Studio for that.`),
      );
    default:
      return reportError(
        io,
        looksLikeJsonRequested(rest),
        verb,
        new CliError(EXIT_CODES.USAGE, `unknown command: ${verb} (see --help)`),
      );
  }
}
