// SPDX-License-Identifier: MIT
//
// Speech-to-speech (realtime) registry, verified against
// packages/realtime/src/from-openai-realtime.ts and
// packages/grok/src/from-grok-realtime.ts. Mirrors
// examples/02-hello-voice-headless/scripts/run-realtime-oneturn-smoke.ts:
// `fromXRealtime({ apiKey, socketFactory })` -> `RealtimeAdapter`, wrapped in
// `new RealtimeBridge(adapter)` and registered on the "realtime" slot with
// `endpointingOwner: "timer"`.

import type { RealtimeProvider } from "../options.js";
import type { RealtimeProviderEmission } from "./types.js";

const PKG_VERSION = "^4.3.0";

export const REALTIME_PROVIDERS: Readonly<Record<RealtimeProvider, RealtimeProviderEmission | undefined>> = {
  realtime: {
    packageName: "@kuralle-syrinx/realtime",
    packageVersion: PKG_VERSION,
    envKeys: [{ key: "OPENAI_API_KEY", required: true }],
    importLines: [`import { fromOpenAIRealtime } from "@kuralle-syrinx/realtime";`],
    adapterExpr: (envRef, socketFactoryIdent) => `fromOpenAIRealtime({ apiKey: ${envRef("OPENAI_API_KEY")}, socketFactory: ${socketFactoryIdent} })`,
  },
  grok: {
    packageName: "@kuralle-syrinx/grok",
    packageVersion: PKG_VERSION,
    envKeys: [{ key: "XAI_API_KEY", required: true }],
    importLines: [`import { fromGrokRealtime } from "@kuralle-syrinx/grok/realtime";`],
    adapterExpr: (envRef, socketFactoryIdent) => `fromGrokRealtime({ apiKey: ${envRef("XAI_API_KEY")}, socketFactory: ${socketFactoryIdent} })`,
  },
};
