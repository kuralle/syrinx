// SPDX-License-Identifier: MIT
//
// Emits scripts/dev-server.ts for the node runtime — a transport host that
// resolves --agent <module>[#export] exactly like
// examples/02-hello-voice-headless/scripts/dev-server.ts, minus that example's
// Studio-asset serving (this is a standalone project, not inside the monorepo;
// bring your own browser client, e.g. @kuralle-syrinx/browser-client).

import type { Transport } from "../options.js";

interface TransportServerBinding {
  readonly factoryName: string;
  readonly extraOptions: readonly string[];
  readonly urlPath: string;
}

const TRANSPORT_SERVERS: Readonly<Record<Transport, TransportServerBinding>> = {
  browser: { factoryName: "createVoiceWebSocketServer", extraOptions: [`path: "/ws"`], urlPath: "/ws" },
  twilio: { factoryName: "createTwilioMediaStreamServer", extraOptions: [], urlPath: "/" },
  telnyx: { factoryName: "createTelnyxMediaStreamServer", extraOptions: [], urlPath: "/" },
  smartpbx: { factoryName: "createSmartPbxMediaStreamServer", extraOptions: [], urlPath: "/" },
};

export function buildDevServer(transport: Transport): string {
  const binding = TRANSPORT_SERVERS[transport];
  const optionsLines = [`    port,`, `    host,`, ...binding.extraOptions.map((l) => `    ${l},`), `    createSession: () => factory(),`];

  return `// SPDX-License-Identifier: MIT
//
// Local dev server — wires YOUR agent module to a ${transport} transport host.
//
//   pnpm dev -- --agent ./src/agent.ts#createAgent
//
// --agent is <module>[#namedExport]; the export is a zero-arg factory
// returning a VoiceAgentSession. Same seam as
// examples/02-hello-voice-headless/scripts/dev-server.ts.

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ${binding.factoryName}, installGracefulShutdown } from "@kuralle-syrinx/server-websocket";
import type { VoiceAgentSession } from "@kuralle-syrinx/core";

export type SessionFactory = () => VoiceAgentSession | Promise<VoiceAgentSession>;

/**
 * Resolve \`--agent <module>[#export]\` to a factory. Fails loudly and
 * specifically — a dev server that silently falls back to a different agent
 * than the one you asked for is worse than one that refuses to start.
 */
async function resolveAgentFactory(spec: string | undefined): Promise<{ factory: SessionFactory; label: string }> {
  if (!spec) throw new Error("--agent <module>[#export] is required, e.g. --agent ./src/agent.ts#createAgent");
  const [modulePath, exportName] = spec.split("#");
  if (!modulePath) throw new Error(\`--agent needs a module path, got: \${spec}\`);
  const abs = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;

  const picked = exportName ? mod[exportName] : (mod["default"] ?? mod["createAgent"] ?? mod["createSession"]);
  if (typeof picked !== "function") {
    const available = Object.keys(mod).filter((k) => typeof mod[k] === "function");
    throw new Error(
      \`\${abs} has no callable export \${exportName ? \`"\${exportName}"\` : "(default, createAgent, or createSession)"}. \` +
        \`Callable exports: \${available.length > 0 ? available.join(", ") : "(none)"}\`,
    );
  }
  return { factory: picked as SessionFactory, label: \`\${modulePath}\${exportName ? \`#\${exportName}\` : ""}\` };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readPort(): number {
  const raw = process.env["SYRINX_DEV_PORT"]?.trim();
  if (!raw) return 4173;
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error(\`invalid SYRINX_DEV_PORT: \${raw}\`);
  return port;
}

async function main(): Promise<void> {
  const { factory, label } = await resolveAgentFactory(flag(process.argv.slice(2), "--agent"));
  const port = readPort();
  const host = process.env["SYRINX_DEV_HOST"]?.trim() || "127.0.0.1";

  const server = await ${binding.factoryName}({
${optionsLines.join("\n")}
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  console.log(\`Syrinx dev server (${transport}): ws://\${host}:\${String(address.port)}${binding.urlPath}\`);
  console.log(\`Agent: \${label}\`);

  installGracefulShutdown(server, { drainDeadlineMs: 10_000, onClosed: () => process.exit(0) });
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
`;
}
