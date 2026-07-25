// SPDX-License-Identifier: MIT
//
// `syrinx turn --in <fixture.wav|fixture.json> --agent <module>#<export>` —
// resolves the caller's own agent (the CLI brings no providers) and drives it
// through the shared, provider-agnostic turn driver, mirroring
// examples/02-hello-voice-headless/scripts/replay-fixture.ts's fixture-replay
// contract but as a first-class CLI verb with --json output and typed exit
// codes instead of a throwaway script's console.log/process.exit.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import { resolveAgentFactory } from "./agent-resolve.js";
import { CliError, EXIT_CODES } from "./exit-codes.js";
import { assertTranscript, loadFixture, type TranscriptAssertion } from "./fixture.js";
import { driveTurn, type PerTurnMetrics } from "./turn-runner.js";

export interface RunTurnCommandOptions {
  readonly inputPath: string;
  readonly agentSpec: string;
  readonly sessionDir?: string;
  readonly cwd?: string;
}

export interface TurnCommandResult {
  readonly input: string;
  readonly agent: string;
  readonly sessionDir: string;
  readonly transcript: string;
  readonly reply: string;
  readonly timings: PerTurnMetrics;
  readonly durationMs: number;
  readonly assertion: TranscriptAssertion | null;
}

export async function runTurnCommand(opts: RunTurnCommandOptions): Promise<TurnCommandResult> {
  // Validate the input itself before resolving the agent: a malformed/unreplayable
  // fixture is a usage problem an agent should see regardless of whether the
  // --agent module even resolves.
  const inputPath = resolve(opts.inputPath);
  const isFixtureSidecar = extname(inputPath).toLowerCase() === ".json";
  const fixture = isFixtureSidecar ? loadFixture(inputPath) : undefined;
  const wavPath = fixture ? fixture.wavPath : inputPath;

  const resolvedAgent = await resolveAgentFactory(opts.agentSpec, opts.cwd ?? process.cwd());
  const sessionDir = opts.sessionDir ?? mkdtempSync(join(tmpdir(), "syrinx-turn-"));

  let result;
  try {
    result = await driveTurn({
      session: resolvedAgent.factory,
      inputWavPath: wavPath,
      sessionDir,
    });
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(EXIT_CODES.BACKEND, `turn failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let assertion: TranscriptAssertion | null = null;
  if (fixture?.sidecar.expectedTranscript !== undefined) {
    assertion = assertTranscript(fixture.sidecar.expectedTranscript, result.finalTranscript);
    if (!assertion.match) {
      throw new CliError(EXIT_CODES.ASSERTION, "replayed fixture's transcript drifted from the expected transcript", {
        assertion,
      });
    }
  }

  return {
    input: inputPath,
    agent: resolvedAgent.label,
    sessionDir: result.sessionDir,
    transcript: result.finalTranscript,
    reply: result.agentReply,
    timings: result.metrics,
    durationMs: result.durationMs,
    assertion,
  };
}
