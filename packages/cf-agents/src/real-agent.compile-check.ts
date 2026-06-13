// SPDX-License-Identifier: MIT
//
// Compile-only proof that `withVoice` composes with the REAL `agents` SDK Agent
// (not just the test's fake base). Type-checked by `tsc --noEmit`; never run.
// If the agents SDK changes the Agent / Connection / ConnectionContext surface
// the mixin relies on, this file fails to compile.

import { Agent } from "agents";
import type { VoicePlugin } from "@kuralle-syrinx/core";
import { fromGeminiLive } from "@kuralle-syrinx/realtime";
import { withVoice } from "./with-voice.js";

interface Env extends Record<string, unknown> {
  GEMINI_API_KEY: string;
}

// Realtime front: the agent's own kuralle runtime is the brain (default reasoner).
export class RealtimeVoiceAgent extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: {
    kind: "realtime",
    front: (env) => fromGeminiLive({ apiKey: env.GEMINI_API_KEY }),
    delegateToolName: "consult_knowledge",
  },
}) {}

// Cascaded: explicit reasoner + discrete stt/tts stages.
const noopPlugin: VoicePlugin = { initialize: async () => {}, close: async () => {} };

export class CascadedVoiceAgent extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: {
    kind: "cascaded",
    stt: () => ({ plugin: noopPlugin, config: { model: "nova-3" } }),
    tts: () => ({ plugin: noopPlugin, config: { voice_id: "v" } }),
  },
  reasoner: () => ({
    // eslint-disable-next-line require-yield
    stream: async function* () {
      return;
    },
  }),
}) {}
