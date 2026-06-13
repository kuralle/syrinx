// SPDX-License-Identifier: MIT
//
// @kuralle-syrinx/cf-agents — add a Syrinx voice pipeline (realtime or cascaded) to
// a Cloudflare `agents` SDK Agent via the `withVoice(Agent, options)` mixin.

export { withVoice, type WithVoiceOptions, type WithVoiceMembers } from "./with-voice.js";
export type {
  VoicePipeline,
  RealtimePipeline,
  CascadedPipeline,
  CascadedStage,
  VoicePipelineContext,
} from "./build-session.js";
export { connectionManagedSocket } from "./connection-socket.js";
export type { VoiceConnection, ConnectionSocketController } from "./connection-socket.js";
