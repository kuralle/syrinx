// SPDX-License-Identifier: MIT
//
// Builds the generated project's package.json — dependencies limited to
// exactly the chosen providers (LDT-21 requirement), plus the fixed
// infrastructure every combination needs: core, the CLI (for `syrinx turn`/
// `syrinx text` in the check:* scripts), and tsx (the --agent seam needs it
// for a .ts module — see AGENTS.md).

import type { ResolvedOptions } from "../options.js";
import { STT_STAGE_PROVIDERS } from "../providers/stt.js";
import { TTS_STAGE_PROVIDERS } from "../providers/tts.js";
import { REASONER_PROVIDERS } from "../providers/reasoner.js";
import { REALTIME_PROVIDERS } from "../providers/realtime.js";
import { VAD_SIDECAR_PROVIDERS, ENDPOINTING_SIDECAR_PROVIDERS } from "../providers/vad-endpointing.js";

const CORE_VERSION = "^4.3.0";

// @kuralle-syrinx/server-websocket (and any ws-based STT/TTS/realtime provider,
// transitively through @kuralle-syrinx/ws) ships raw TS as "main" and declares
// `ws` as a runtime dep but `@types/ws` only as a devDependency — devDeps of a
// dependency are never installed for the consumer, so a project that typechecks
// server-websocket's source needs its own `@types/ws` (mirrors
// examples/02-hello-voice-headless/package.json, which declares both directly).
function transportPackage(): Readonly<Record<string, string>> {
  return { "@kuralle-syrinx/server-websocket": CORE_VERSION, ws: "^8.21.0" };
}

export function collectDependencies(opts: ResolvedOptions): Record<string, string> {
  const deps: Record<string, string> = {
    "@kuralle-syrinx/core": CORE_VERSION,
    ...transportPackage(),
  };

  if (opts.mode === "cascade") {
    const stt = STT_STAGE_PROVIDERS[opts.stt];
    const tts = TTS_STAGE_PROVIDERS[opts.tts];
    const reasoner = REASONER_PROVIDERS[opts.reasoner];
    if (stt) deps[stt.packageName] = stt.packageVersion;
    if (tts) deps[tts.packageName] = tts.packageVersion;
    // ReasoningBridge (the VoicePlugin wrapper any Reasoner needs in cascade mode) lives here.
    deps["@kuralle-syrinx/aisdk"] = CORE_VERSION;
    if (reasoner) {
      deps[reasoner.packageName] = reasoner.packageVersion;
      Object.assign(deps, reasoner.extraPackages);
    }
    const vad = opts.vad !== undefined ? VAD_SIDECAR_PROVIDERS[opts.vad] : undefined;
    if (vad) deps[vad.packageName] = vad.packageVersion;
    const eos = opts.endpointing !== undefined ? ENDPOINTING_SIDECAR_PROVIDERS[opts.endpointing] : undefined;
    if (eos) deps[eos.packageName] = eos.packageVersion;
  } else {
    const realtime = REALTIME_PROVIDERS[opts.realtime];
    // RealtimeBridge (the generic VoicePlugin wrapper around any RealtimeAdapter) lives here.
    deps["@kuralle-syrinx/realtime"] = CORE_VERSION;
    deps["@kuralle-syrinx/ws"] = CORE_VERSION;
    if (realtime) deps[realtime.packageName] = realtime.packageVersion;
  }

  return deps;
}

export function buildPackageJson(opts: ResolvedOptions): string {
  const dependencies = collectDependencies(opts);
  const agentSpec = "./src/agent.ts#createAgent";

  const scripts: Record<string, string> = {
    dev: `tsx scripts/dev-server.ts --agent ${agentSpec}`,
    "check:typecheck": "tsc --noEmit",
    "check:turn": `syrinx turn --in test/fixtures/smoke.wav --agent ${agentSpec} --json`,
  };
  const devDependencies: Record<string, string> = {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.18.1",
    tsx: "^4.20.0",
    typescript: "^5.7.0",
  };

  // --runtime cloudflare additionally ships src/index.ts (the deploy artifact, a
  // withVoice(Agent) Durable Object) + wrangler.jsonc alongside the SAME src/agent.ts
  // + scripts/dev-server.ts used for local iteration and check:turn — the deploy
  // artifact's own typecheck is covered by check:typecheck (tsconfig includes all of
  // src/), but it is not live-verified (see AGENTS.md / the --transport telnyx warning).
  if (opts.runtime === "cloudflare") {
    dependencies["@kuralle-syrinx/cf-agents"] = CORE_VERSION;
    dependencies["agents"] = "0.14.0";
    // `agents` peer-depends on ai@^6.0.0, but its own optional @cloudflare/ai-chat
    // dependency pulls a newer `ai` major transitively — without a direct pin here
    // npm's resolver lands on the newer major and ERESOLVEs against agents' peer.
    // examples/03-cf-agent-voice/package.json pins the same "ai": "^6.0.0" for the
    // same reason, in both its cascaded AND realtime example classes.
    dependencies["ai"] = "^6.0.0";
    // Pinned exact, not a caret range: `wrangler`'s peer on @cloudflare/workers-types
    // moved to v5 in newer releases while `agents`/`partyserver` still peer on v4,
    // so a loose `^4.19.0` resolves npm to the newest 4.x wrangler and hits an
    // ERESOLVE conflict. This exact pair is the one this monorepo's own
    // pnpm-lock.yaml already resolves.
    devDependencies["@cloudflare/workers-types"] = "^4.20260601.1";
    devDependencies["wrangler"] = "4.97.0";
    scripts["check:wrangler-dry-run"] = "wrangler deploy --dry-run";
  }

  const pkg = {
    name: opts.name,
    version: "0.0.1",
    private: true,
    type: "module",
    license: "MIT",
    scripts,
    dependencies: sortKeys({ ...dependencies, "@kuralle-syrinx/cli": CORE_VERSION }),
    devDependencies: sortKeys(devDependencies),
  };

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key] as string;
  return out;
}
