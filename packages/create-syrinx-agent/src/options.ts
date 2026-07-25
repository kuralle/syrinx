// SPDX-License-Identifier: MIT
//
// The flag matrix, verified against packages/* — do not invent provider
// names here. What's implemented per stage lives in the provider registries
// in providers/*.ts, not here: this module only parses and validates shape.

import { resolve } from "node:path";

import { CliError, EXIT_CODES } from "./exit-codes.js";

export const STT_PROVIDERS = ["deepgram", "google", "elevenlabs", "grok"] as const;
export const TTS_PROVIDERS = ["cartesia", "elevenlabs", "gemini", "openai-tts", "grok"] as const;
export const REALTIME_PROVIDERS = ["realtime", "grok"] as const;
export const REASONER_PROVIDERS = ["aisdk", "kuralle", "mastra"] as const;
export const VAD_PROVIDERS = ["silero-vad"] as const;
export const ENDPOINTING_PROVIDERS = ["pipecat-smart-turn", "vap"] as const;
export const TRANSPORTS = ["browser", "twilio", "telnyx", "smartpbx"] as const;
export const RUNTIMES = ["node", "cloudflare"] as const;

export type SttProvider = (typeof STT_PROVIDERS)[number];
export type TtsProvider = (typeof TTS_PROVIDERS)[number];
export type RealtimeProvider = (typeof REALTIME_PROVIDERS)[number];
export type ReasonerProvider = (typeof REASONER_PROVIDERS)[number];
export type VadProvider = (typeof VAD_PROVIDERS)[number];
export type EndpointingProvider = (typeof ENDPOINTING_PROVIDERS)[number];
export type Transport = (typeof TRANSPORTS)[number];
export type Runtime = (typeof RUNTIMES)[number];

/** Flags as parsed off the command line — everything optional, everything a string. */
export interface RawFlags {
  readonly stt?: string | undefined;
  readonly tts?: string | undefined;
  readonly realtime?: string | undefined;
  readonly reasoner?: string | undefined;
  readonly vad?: string | undefined;
  readonly endpointing?: string | undefined;
  readonly transport?: string | undefined;
  readonly runtime?: string | undefined;
  readonly preset?: string | undefined;
  readonly name?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly "no-install"?: boolean | undefined;
  readonly "skip-install"?: boolean | undefined;
  readonly "dry-run"?: boolean | undefined;
}

/** A resolved, valid selection — either cascade (stt+tts+reasoner) or speech-to-speech (realtime). */
export type ResolvedOptions =
  | {
      readonly mode: "cascade";
      readonly stt: SttProvider;
      readonly tts: TtsProvider;
      readonly reasoner: ReasonerProvider;
      readonly vad: VadProvider | undefined;
      readonly endpointing: EndpointingProvider | undefined;
      readonly transport: Transport;
      readonly runtime: Runtime;
      readonly name: string;
      /** Absolute path the project is written to. NOT `name` — see resolveOptions. */
      readonly targetDir: string;
      readonly skipInstall: boolean;
      readonly dryRun: boolean;
    }
  | {
      readonly mode: "realtime";
      readonly realtime: RealtimeProvider;
      readonly transport: Transport;
      readonly runtime: Runtime;
      readonly name: string;
      /** Absolute path the project is written to. NOT `name` — see resolveOptions. */
      readonly targetDir: string;
      readonly skipInstall: boolean;
      readonly dryRun: boolean;
    };

interface Preset {
  readonly stt?: SttProvider;
  readonly tts?: TtsProvider;
  readonly reasoner?: ReasonerProvider;
  readonly transport?: Transport;
  readonly runtime?: Runtime;
}

// Presets are flag bundles, not a separate code path — every field here is
// exactly a field an explicit flag can also set, and an explicit flag wins.
const PRESETS: Readonly<Record<string, Preset>> = {
  phone: { stt: "deepgram", tts: "cartesia", reasoner: "aisdk", transport: "twilio", runtime: "node" },
};

function memberOf<T extends readonly string[]>(list: T, value: string, flagName: string): T[number] {
  if (!(list as readonly string[]).includes(value)) {
    throw new CliError(EXIT_CODES.USAGE, `--${flagName} must be one of: ${list.join(", ")} (got "${value}")`);
  }
  return value as T[number];
}

/**
 * Merge a preset under explicit flags (explicit always wins), validate shape,
 * and refuse the one hard conflict: --realtime combined with --stt/--tts.
 * Missing required fields in cascade mode are a USAGE error — this generator
 * never prompts, see help.ts's documented contract.
 */
export function resolveOptions(raw: RawFlags, positionals: readonly string[]): ResolvedOptions {
  if (raw.preset !== undefined && !(raw.preset in PRESETS)) {
    throw new CliError(EXIT_CODES.USAGE, `--preset must be one of: ${Object.keys(PRESETS).join(", ")} (got "${raw.preset}")`);
  }
  const preset = raw.preset !== undefined ? PRESETS[raw.preset] : undefined;

  const sttRaw = raw.stt ?? preset?.stt;
  const ttsRaw = raw.tts ?? preset?.tts;
  const reasonerRaw = raw.reasoner ?? preset?.reasoner;
  const realtimeRaw = raw.realtime;

  if (realtimeRaw !== undefined && (sttRaw !== undefined || ttsRaw !== undefined)) {
    throw new CliError(
      EXIT_CODES.USAGE,
      `--realtime is a speech-to-speech pipeline with no separate STT/TTS stages — it cannot be combined with ${[
        sttRaw !== undefined ? "--stt" : undefined,
        ttsRaw !== undefined ? "--tts" : undefined,
      ]
        .filter((v): v is string => v !== undefined)
        .join(" and ")}.`,
    );
  }

  const transport = memberOf(TRANSPORTS, raw.transport ?? preset?.transport ?? "browser", "transport");
  const runtime = memberOf(RUNTIMES, raw.runtime ?? preset?.runtime ?? "node", "runtime");
  const skipInstall = raw["no-install"] === true || raw["skip-install"] === true;
  const dryRun = raw["dry-run"] === true;
  const targetDir = positionals[0];
  const name = raw.name ?? (targetDir !== undefined ? targetDir.split("/").filter(Boolean).at(-1) : undefined);
  if (name === undefined || name.length === 0) {
    throw new CliError(EXIT_CODES.USAGE, "a target directory or --name is required, e.g. `create-syrinx-agent my-agent`");
  }
  // Where the files actually go. Distinct from `name`, which is only what the
  // project calls itself: writing to `./<name>` would silently ignore an absolute
  // or nested target and scatter a project into whatever directory you ran from.
  const resolvedTarget = resolve(process.cwd(), targetDir ?? name);

  if (realtimeRaw !== undefined) {
    const realtime = memberOf(REALTIME_PROVIDERS, realtimeRaw, "realtime");
    return { mode: "realtime", realtime, transport, runtime, name, targetDir: resolvedTarget, skipInstall, dryRun };
  }

  const missing = [
    sttRaw === undefined ? "--stt" : undefined,
    ttsRaw === undefined ? "--tts" : undefined,
    reasonerRaw === undefined ? "--reasoner" : undefined,
  ].filter((v): v is string => v !== undefined);
  if (missing.length > 0) {
    throw new CliError(
      EXIT_CODES.USAGE,
      `missing required flag(s): ${missing.join(", ")} (or pass --realtime for a speech-to-speech pipeline, or --preset <name>)`,
    );
  }

  const stt = memberOf(STT_PROVIDERS, sttRaw as string, "stt");
  const tts = memberOf(TTS_PROVIDERS, ttsRaw as string, "tts");
  const reasoner = memberOf(REASONER_PROVIDERS, reasonerRaw as string, "reasoner");
  const vad = raw.vad !== undefined ? memberOf(VAD_PROVIDERS, raw.vad, "vad") : undefined;
  const endpointing = raw.endpointing !== undefined ? memberOf(ENDPOINTING_PROVIDERS, raw.endpointing, "endpointing") : undefined;

  return { mode: "cascade", stt, tts, reasoner, vad, endpointing, transport, runtime, name, targetDir: resolvedTarget, skipInstall, dryRun };
}

/** Non-fatal warnings for combinations that generate but aren't fully verified. */
export function warningsFor(opts: ResolvedOptions): readonly string[] {
  const warnings: string[] = [];
  if (opts.runtime === "cloudflare" && opts.transport === "telnyx") {
    warnings.push(
      "runtime=cloudflare + transport=telnyx is generated but not yet bound on the Workers edge — deploy-unverified. " +
        "See @kuralle-syrinx/server-workers for current Cloudflare transport coverage before deploying.",
    );
  }
  return warnings;
}
