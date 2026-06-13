// SPDX-License-Identifier: MIT

export { createTtsEngine, type TtsEngine, type TtsEngineDeps } from "./engine.js";
export {
  startStreamingTtsSession,
  defaultNodeSocketFactory,
  type StreamingTtsSpec,
  type StreamingTtsSession,
} from "./plugin.js";
export {
  attributionKey,
  type AttributionKey,
  type WireEvent,
  type WireProtocol,
  type Transport,
  type TimerPort,
  type TimerHandle,
  type PacketSink,
} from "./types.js";
