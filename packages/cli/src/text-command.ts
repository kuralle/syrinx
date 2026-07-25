// SPDX-License-Identifier: MIT
//
// `syrinx text "<message>" --agent <module>#<export>` — resolves the caller's
// own agent and drives one typed turn through it. The CLI brings no reasoner.

import { resolveAgentFactory } from "./agent-resolve.js";
import { CliError, EXIT_CODES } from "./exit-codes.js";
import { driveText, type TextTurnResult } from "./text-turn.js";

export interface RunTextCommandOptions {
  readonly message: string;
  readonly agentSpec: string;
  readonly cwd?: string;
}

export interface TextCommandResult extends TextTurnResult {
  readonly agent: string;
}

export async function runTextCommand(opts: RunTextCommandOptions): Promise<TextCommandResult> {
  const resolvedAgent = await resolveAgentFactory(opts.agentSpec, opts.cwd ?? process.cwd());

  let result: TextTurnResult;
  try {
    result = await driveText({ session: resolvedAgent.factory, message: opts.message });
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(EXIT_CODES.BACKEND, `text turn failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ...result, agent: resolvedAgent.label };
}
