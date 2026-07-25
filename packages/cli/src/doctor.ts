// SPDX-License-Identifier: MIT
//
// `syrinx doctor` — reports what is configured and what is missing. Never prints
// key values, only presence. Always exits SUCCESS: this verb diagnoses, it does
// not assert.
//
// This CLI has no fixed provider set — it never constructs an STT/TTS/reasoner
// itself (see --agent, agent-resolve.ts). So doctor cannot claim "ready for
// turn"/"ready for text" against a hardcoded key list; it reports well-known
// provider keys as informational only, and — when given --agent — reports
// whether that specific agent module resolves.

import { resolveAgentFactory } from "./agent-resolve.js";
import { CliError } from "./exit-codes.js";
import { CLI_VERSION, CORE_PACKAGE_NAME, checkCoreVersionSkew, majorOf } from "./version.js";

/** Commonly used in the Syrinx ecosystem — shown for convenience only. The CLI itself does not require any of these; whatever --agent resolves to owns its own provider requirements. */
export const WELL_KNOWN_PROVIDER_KEYS = ["DEEPGRAM_API_KEY", "OPENAI_API_KEY", "CARTESIA_API_KEY", "GEMINI_API_KEY", "ELEVENLABS_API_KEY", "GROK_API_KEY"] as const;

export type WellKnownProviderKey = (typeof WELL_KNOWN_PROVIDER_KEYS)[number];

export interface DoctorAgentReport {
  readonly spec: string;
  readonly resolved: boolean;
  readonly label?: string;
  readonly error?: string;
}

export interface DoctorReport {
  readonly cliVersion: string;
  readonly node: { readonly version: string; readonly platform: string };
  readonly core: {
    readonly package: string;
    readonly resolved: boolean;
    readonly version: string | undefined;
    readonly cliMajor: string;
    readonly coreMajor: string | undefined;
    readonly majorMismatch: boolean;
  };
  /** Informational only — presence, never the value. This CLI does not require any specific set; see `agent`. */
  readonly wellKnownProviderKeys: Readonly<Record<WellKnownProviderKey, boolean>>;
  readonly agent: DoctorAgentReport | null;
  readonly summary: string;
}

export interface RunDoctorOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion?: string;
  readonly platform?: string;
  /** `--agent <module>#<export>` — when given, doctor resolves (imports + finds the callable export) but does not invoke it, so checking doesn't require live provider access. */
  readonly agentSpec?: string;
}

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorReport> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const skew = checkCoreVersionSkew(cwd);

  const wellKnownProviderKeys = Object.fromEntries(
    WELL_KNOWN_PROVIDER_KEYS.map((key) => [key, Boolean(env[key]?.trim())]),
  ) as Record<WellKnownProviderKey, boolean>;

  let agent: DoctorAgentReport | null = null;
  if (opts.agentSpec) {
    try {
      const resolved = await resolveAgentFactory(opts.agentSpec, cwd);
      agent = { spec: opts.agentSpec, resolved: true, label: resolved.label };
    } catch (err) {
      agent = {
        spec: opts.agentSpec,
        resolved: false,
        error: err instanceof CliError ? err.message : err instanceof Error ? err.message : String(err),
      };
    }
  }

  const summary = !skew.coreResolved
    ? `${CORE_PACKAGE_NAME} is not installed in this project`
    : agent
      ? agent.resolved
        ? `agent resolved: ${agent.label}`
        : `agent could not be resolved: ${agent.error}`
      : "pass --agent <module>#<export> to check whether a specific agent resolves; the provider keys above are informational only — this CLI does not require any specific set";

  return {
    cliVersion: CLI_VERSION,
    node: { version: opts.nodeVersion ?? process.version, platform: opts.platform ?? process.platform },
    core: {
      package: CORE_PACKAGE_NAME,
      resolved: skew.coreResolved,
      version: skew.coreVersion,
      cliMajor: majorOf(CLI_VERSION),
      coreMajor: skew.coreVersion ? majorOf(skew.coreVersion) : undefined,
      majorMismatch: skew.mismatch,
    },
    wellKnownProviderKeys,
    agent,
    summary,
  };
}
