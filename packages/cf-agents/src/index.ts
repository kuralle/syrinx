// SPDX-License-Identifier: MIT
//
// @kuralle-syrinx/cf-agents — add a Syrinx voice pipeline (realtime, half-cascade, or cascade) to
// a Cloudflare `agents` SDK Agent via the `withVoice(Agent, options)` mixin.

export {
  withVoice,
  type WithVoiceOptions,
  type WithVoiceMembers,
  type ToolCallStartContext,
  type DelegateQueryContext,
  type DelegateResultContext,
  type TurnContext,
} from "./with-voice.js";
export type {
  VoicePipelineFields,
  VoiceShape,
  CascadedStage,
  CascadedEndpointingOwner,
  VoicePipelineContext,
  VoiceSessionWiring,
} from "./build-session.js";
export { resolveVoiceShape } from "./build-session.js";
export { SqliteReasonerSessionStore, type SqlTag } from "./durable-history.js";
export { connectionManagedSocket } from "./connection-socket.js";
export type { VoiceConnection, ConnectionSocketController } from "./connection-socket.js";
