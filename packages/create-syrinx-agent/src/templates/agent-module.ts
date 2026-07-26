// SPDX-License-Identifier: MIT
//
// Emits src/agent.ts for the node runtime — the module the CLI's --agent
// seam points at (`tsx scripts/dev-server.ts --agent ./src/agent.ts#createAgent`,
// `syrinx turn --agent ./src/agent.ts#createAgent`). Mirrors
// examples/02-hello-voice-headless/src/hello-voice-agent.ts (cascade) and
// scripts/run-realtime-oneturn-smoke.ts (realtime).

import type { ResolvedOptions } from "../options.js";
import { STT_STAGE_PROVIDERS } from "../providers/stt.js";
import { TTS_STAGE_PROVIDERS } from "../providers/tts.js";
import { REASONER_PROVIDERS, SYSTEM_PROMPT_CONST } from "../providers/reasoner.js";
import { REALTIME_PROVIDERS } from "../providers/realtime.js";
import { VAD_SIDECAR_PROVIDERS, ENDPOINTING_SIDECAR_PROVIDERS } from "../providers/vad-endpointing.js";
import { CliError, EXIT_CODES } from "../exit-codes.js";
import type { StageProvider } from "../providers/types.js";

const SYSTEM_PROMPT = "You are a helpful voice assistant. Keep your replies short.";

function nodeEnvRef(key: string): string {
  return `process.env["${key}"] ?? ""`;
}

function requireStage(provider: StageProvider | undefined, flag: string, value: string): StageProvider {
  if (provider === undefined) {
    throw new CliError(EXIT_CODES.USAGE, `--${flag} ${value} is not yet implemented by this generator`);
  }
  return provider;
}

function importLine(className: string, from: string): string {
  return `import { ${className} } from "${from}";`;
}

/** Merge `import { A } from "x"; import { B } from "x";` pairs sharing one module into one line. */
function mergeImports(lines: readonly string[]): string[] {
  const IMPORT_RE = /^import \{ (.+) \} from "(.+)";$/;
  const sourceOrder: string[] = [];
  const namesBySource = new Map<string, string[]>();

  for (const line of lines) {
    const match = IMPORT_RE.exec(line);
    const names = match?.[1];
    const from = match?.[2];
    if (names === undefined || from === undefined) {
      // Silently skipping here emits an agent module missing an import, which fails
      // only in the GENERATED project — far from the cause. It happened: a two-line
      // entry never matched this single-line-anchored regex and vanished.
      throw new Error(`agent-module: import line not in the expected shape: ${line}`);
    }
    let bucket = namesBySource.get(from);
    if (bucket === undefined) {
      bucket = [];
      namesBySource.set(from, bucket);
      sourceOrder.push(from);
    }
    for (const name of names.split(",").map((n) => n.trim())) {
      if (!bucket.includes(name)) bucket.push(name);
    }
  }

  return sourceOrder.map((from) => `import { ${(namesBySource.get(from) ?? []).join(", ")} } from "${from}";`);
}

export function buildAgentModule(opts: ResolvedOptions): string {
  if (opts.mode === "realtime") return buildRealtimeAgentModule(opts);
  return buildCascadeAgentModule(opts);
}

function buildCascadeAgentModule(opts: Extract<ResolvedOptions, { mode: "cascade" }>): string {
  const stt = requireStage(STT_STAGE_PROVIDERS[opts.stt], "stt", opts.stt);
  const tts = requireStage(TTS_STAGE_PROVIDERS[opts.tts], "tts", opts.tts);
  const reasoner = REASONER_PROVIDERS[opts.reasoner];
  if (reasoner === undefined) {
    throw new CliError(EXIT_CODES.USAGE, `--reasoner ${opts.reasoner} is not yet implemented by this generator`);
  }
  const vad = opts.vad !== undefined ? VAD_SIDECAR_PROVIDERS[opts.vad] : undefined;
  if (opts.vad !== undefined && vad === undefined) {
    throw new CliError(EXIT_CODES.USAGE, `--vad ${opts.vad} is not yet implemented by this generator`);
  }
  const eos = opts.endpointing !== undefined ? ENDPOINTING_SIDECAR_PROVIDERS[opts.endpointing] : undefined;
  if (opts.endpointing !== undefined && eos === undefined) {
    throw new CliError(EXIT_CODES.USAGE, `--endpointing ${opts.endpointing} is not yet implemented by this generator`);
  }
  const endpointingOwner = eos !== undefined ? "smart_turn" : stt.ownsEndpointing ? "provider_stt" : undefined;
  if (endpointingOwner === undefined) {
    throw new CliError(
      EXIT_CODES.USAGE,
      `--stt ${opts.stt} cannot own endpointing on its own — pass --endpointing pipecat-smart-turn`,
    );
  }

  const imports = [
    `import { VoiceAgentSession, type VoicePlugin } from "@kuralle-syrinx/core";`,
    `import { config as loadEnv } from "dotenv";`,
    `import { ReasoningBridge } from "@kuralle-syrinx/aisdk";`,
    importLine(stt.className, stt.importFrom ?? stt.packageName),
    importLine(tts.className, tts.importFrom ?? tts.packageName),
    ...(vad !== undefined ? [importLine(vad.className, vad.packageName)] : []),
    ...(eos !== undefined ? [importLine(eos.className, eos.packageName)] : []),
    ...reasoner.importLines(nodeEnvRef),
  ];

  const pluginConfigLines: string[] = [
    `      stt: {`,
    ...stt.configFields(nodeEnvRef).map((f) => `        ${f},`),
    `      },`,
  ];
  if (vad !== undefined) pluginConfigLines.push(`      vad: {},`);
  if (eos !== undefined) pluginConfigLines.push(`      eos: {},`);
  pluginConfigLines.push(
    `      bridge: {},`,
    `      tts: {`,
    ...tts.configFields(nodeEnvRef).map((f) => `        ${f},`),
    `      },`,
  );

  const pluginInstanceLines: string[] = [`    stt: new ${stt.className}(),`];
  if (vad !== undefined) pluginInstanceLines.push(`    vad: new ${vad.className}(),`);
  if (eos !== undefined) pluginInstanceLines.push(`    eos: new ${eos.className}(),`);
  pluginInstanceLines.push(
    `    bridge: new ReasoningBridge(${reasoner.reasonerExpr}),`,
    `    tts: new ${tts.className}(),`,
  );

  return `// SPDX-License-Identifier: MIT
//
// Cascade voice agent: ${opts.stt} STT -> ${opts.reasoner} reasoner -> ${opts.tts} TTS.
// Generated by create-syrinx-agent. Wired to the local dev server and to
// \`syrinx turn\`/\`syrinx text\` through the --agent <module>#<export> seam
// (examples/02-hello-voice-headless/scripts/dev-server.ts).

${mergeImports(imports).join("\n")}

// This project ships a .env.example. Without this call nothing ever reads the
// .env you make from it, and every provider fails on a missing api_key.
loadEnv();

const ${SYSTEM_PROMPT_CONST} = ${JSON.stringify(SYSTEM_PROMPT)};

export function createAgent(): VoiceAgentSession {
${reasoner.preludeLines(nodeEnvRef).map((l) => `  ${l}`).join("\n")}

  const session = new VoiceAgentSession({
    plugins: {
${pluginConfigLines.join("\n")}
    },
    endpointingOwner: "${endpointingOwner}",
  });

  const plugins: Record<string, VoicePlugin> = {
${pluginInstanceLines.join("\n")}
  };
  for (const [name, plugin] of Object.entries(plugins)) {
    session.registerPlugin(name, plugin);
  }

  return session;
}
`;
}

function buildRealtimeAgentModule(opts: Extract<ResolvedOptions, { mode: "realtime" }>): string {
  const realtime = REALTIME_PROVIDERS[opts.realtime];
  if (realtime === undefined) {
    throw new CliError(EXIT_CODES.USAGE, `--realtime ${opts.realtime} is not yet implemented by this generator`);
  }

  const imports = [
    `import { VoiceAgentSession } from "@kuralle-syrinx/core";`,
    `import { RealtimeBridge } from "@kuralle-syrinx/realtime";`,
    `import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";`,
    ...realtime.importLines,
  ];

  return `// SPDX-License-Identifier: MIT
//
// Speech-to-speech voice agent: ${opts.realtime} realtime. Generated by
// create-syrinx-agent. Wired to the local dev server and to
// \`syrinx turn\`/\`syrinx text\` through the --agent <module>#<export> seam
// (examples/02-hello-voice-headless/scripts/dev-server.ts).

${mergeImports(imports).join("\n")}

export function createAgent(): VoiceAgentSession {
  const adapter = ${realtime.adapterExpr(nodeEnvRef, "createNodeWsSocket")};
  const bridge = new RealtimeBridge(adapter);

  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);

  return session;
}
`;
}
