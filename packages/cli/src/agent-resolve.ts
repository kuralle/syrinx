// SPDX-License-Identifier: MIT
//
// Resolves `--agent <module>[#export]` to a zero-arg VoiceAgentSession factory.
// Same contract as examples/02-hello-voice-headless/scripts/dev-server.ts's
// `resolveAgentFactory` (LDT-1) — the module path is user-owned code that
// brings its own providers; the CLI itself never constructs an STT/TTS/
// reasoner plugin. Re-implemented here (not imported from the example) because
// the dependency direction runs examples → cli, never the reverse, and
// dev-server.ts is a script in a private example package, not a library export.
//
// Fails loudly and specifically, exactly like dev-server.ts's version: a CLI
// that silently ran a different agent than the one you asked for would be
// worse than one that refuses to start.

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { VoiceAgentSession } from "@kuralle-syrinx/core";

import { CliError, EXIT_CODES } from "./exit-codes.js";
import type { SessionFactory } from "./turn-runner.js";

export interface ResolvedAgent {
  readonly factory: SessionFactory;
  readonly label: string;
}

/**
 * `spec` is `<module>[#namedExport]`, resolved relative to `baseDir` (the
 * invoking project's cwd) when not absolute. The export must be a zero-arg
 * factory returning a VoiceAgentSession (or a Promise of one) — the same
 * shape `--agent` expects in dev-server.ts. Omit `#export` for a default
 * export (or a `createSession` export, checked in that order).
 */
export async function resolveAgentFactory(spec: string, baseDir: string): Promise<ResolvedAgent> {
  const [modulePath, exportName] = spec.split("#");
  if (!modulePath) {
    throw new CliError(EXIT_CODES.USAGE, `--agent needs a module path, got: ${spec}`);
  }

  const abs = isAbsolute(modulePath) ? modulePath : resolve(baseDir, modulePath);
  const url = pathToFileURL(abs).href;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    throw new CliError(EXIT_CODES.USAGE, `could not load --agent module "${modulePath}" (resolved to ${abs}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const picked = exportName ? mod[exportName] : (mod["default"] ?? mod["createSession"]);
  if (typeof picked !== "function") {
    const available = Object.keys(mod).filter((k) => typeof mod[k] === "function");
    throw new CliError(
      EXIT_CODES.USAGE,
      `${abs} has no callable export ${exportName ? `"${exportName}"` : "(default or createSession)"}. ` +
        `Callable exports: ${available.length > 0 ? available.join(", ") : "(none)"}`,
    );
  }

  const factory = picked as SessionFactory;
  const label = `${modulePath}${exportName ? `#${exportName}` : ""}`;

  return {
    label,
    factory: async (): Promise<VoiceAgentSession> => {
      try {
        return await factory();
      } catch (err) {
        // The module resolved and is callable; it failed to actually build a
        // session — most plausibly its own missing config (an env var it
        // needs), so this is a CONFIG-class failure rather than USAGE.
        throw new CliError(
          EXIT_CODES.CONFIG,
          `--agent ${label} failed to construct a session: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
