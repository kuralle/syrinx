// SPDX-License-Identifier: MIT
//
// Optional VAD / endpointing sidecar plugins. `vap` is not yet wired into the
// generator — packages/vap exports an InteractionPolicy (VapInteractionPolicy)
// rather than a drop-in VoicePlugin like PipecatEOSPlugin, which needs
// InteractionCoordinator wiring this generator doesn't yet scaffold.

import type { EndpointingProvider, VadProvider } from "../options.js";
import type { SidecarPluginEmission } from "./types.js";

const PKG_VERSION = "^4.3.0";

export const VAD_SIDECAR_PROVIDERS: Readonly<Record<VadProvider, SidecarPluginEmission | undefined>> = {
  // packages/silero-vad/src/index.ts: SileroVADPlugin. No API key — a bundled ONNX model.
  "silero-vad": {
    packageName: "@kuralle-syrinx/silero-vad",
    packageVersion: PKG_VERSION,
    className: "SileroVADPlugin",
    slot: "vad",
    envKeys: [],
    configFields: () => [],
  },
};

export const ENDPOINTING_SIDECAR_PROVIDERS: Readonly<Record<EndpointingProvider, SidecarPluginEmission | undefined>> = {
  // packages/pipecat-smart-turn/src/index.ts: PipecatEOSPlugin. No API key — a bundled ONNX model.
  "pipecat-smart-turn": {
    packageName: "@kuralle-syrinx/pipecat-smart-turn",
    packageVersion: PKG_VERSION,
    className: "PipecatEOSPlugin",
    slot: "eos",
    envKeys: [],
    configFields: () => [],
  },
  vap: undefined,
};
