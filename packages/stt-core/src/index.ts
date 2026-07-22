// SPDX-License-Identifier: MIT

export { createSttEngine, type SttEngine, type SttEngineDeps } from "./engine.js";
export {
  startStreamingSttSession,
  defaultNodeSocketFactory,
  type StreamingSttSpec,
  type StreamingSttSession,
} from "./session.js";
export type {
  SttEvent,
  SttWireProtocol,
  Transport,
  PacketSink,
} from "./types.js";
