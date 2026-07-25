// SPDX-License-Identifier: MIT
//
// Reasoner registry. `undefined` for a provider not yet wired into the
// generator — kuralle needs a real @kuralle-agents/core Runtime instance
// (fromKuralleRuntime(runtime, opts)), which this generator does not yet
// scaffold; see the report for why.
//
// Every entry's `reasonerExpr` produces a bare `Reasoner` (packages/core's
// stream seam). The cascade template wraps it in `new ReasoningBridge(...)`
// for the node runtime; the Cloudflare template passes it straight to
// `withVoice`'s `reasoner: (env) => ...` — both consume the same expression.
// `ReasoningBridge` itself is NOT imported here: the cascade agent-module
// template always imports it from @kuralle-syrinx/aisdk (it is the generic
// VoicePlugin wrapper around any Reasoner, independent of which provider
// produced it — mirrors examples/.../university-support-mastra.ts, which
// depends on @kuralle-syrinx/aisdk purely for this wrapper).

import type { ReasonerProvider } from "../options.js";
import type { ReasonerProviderEmission } from "./types.js";

const PKG_VERSION = "^4.3.0";
const OPENAI_SDK_VERSION = "^3.0.67";
const AI_SDK_VERSION = "^6.0.0";
const MASTRA_CORE_VERSION = "^1.41.0";

export const SYSTEM_PROMPT_CONST = "SYSTEM_PROMPT";

export const REASONER_PROVIDERS: Readonly<Record<ReasonerProvider, ReasonerProviderEmission | undefined>> = {
  // packages/aisdk/src/from-ai-sdk.ts: fromStreamText(config) -> Reasoner.
  // Mirrors examples/02-hello-voice-headless/src/hello-voice-agent.ts.
  aisdk: {
    packageName: "@kuralle-syrinx/aisdk",
    packageVersion: PKG_VERSION,
    extraPackages: { "@ai-sdk/openai": OPENAI_SDK_VERSION, ai: AI_SDK_VERSION },
    envKeys: [{ key: "OPENAI_API_KEY", required: true }],
    importLines: () => [
      `import { fromStreamText } from "@kuralle-syrinx/aisdk";`,
      `import { createOpenAI } from "@ai-sdk/openai";`,
    ],
    preludeLines: (envRef) => [`const openai = createOpenAI({ apiKey: ${envRef("OPENAI_API_KEY")} });`],
    reasonerExpr: `fromStreamText({ model: openai("gpt-4.1-mini"), system: ${SYSTEM_PROMPT_CONST} })`,
  },
  // packages/mastra/src/from-mastra.ts: fromMastraAgent(agent) -> Reasoner.
  // Mirrors examples/02-hello-voice-headless/src/university-support-mastra.ts.
  mastra: {
    packageName: "@kuralle-syrinx/mastra",
    packageVersion: PKG_VERSION,
    extraPackages: { "@ai-sdk/openai": OPENAI_SDK_VERSION, "@mastra/core": MASTRA_CORE_VERSION },
    envKeys: [{ key: "OPENAI_API_KEY", required: true }],
    importLines: () => [
      `import { fromMastraAgent, type MastraAgentLike } from "@kuralle-syrinx/mastra";`,
      `import { createOpenAI } from "@ai-sdk/openai";`,
      `import { Agent as MastraAgent } from "@mastra/core/agent";`,
    ],
    preludeLines: (envRef) => [
      `const openai = createOpenAI({ apiKey: ${envRef("OPENAI_API_KEY")} });`,
      `const mastraAgent = new MastraAgent({`,
      `  id: "syrinx-agent",`,
      `  name: "syrinx-agent",`,
      `  instructions: ${SYSTEM_PROMPT_CONST},`,
      `  model: openai("gpt-4.1-mini"),`,
      `});`,
    ],
    // Structural cast to MastraAgentLike, same pattern the reference agent uses —
    // fromMastraAgent types against a structural interface, not @mastra/core's own type.
    reasonerExpr: `fromMastraAgent(mastraAgent as unknown as MastraAgentLike)`,
  },
  kuralle: undefined,
};
