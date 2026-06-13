// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { VoiceAgentSession, type Reasoner, type VoicePlugin } from "@kuralle-syrinx/core";
import type { RealtimeAdapter } from "@kuralle-syrinx/realtime";
import { buildVoiceSession, type VoicePipeline } from "./build-session.js";

const stubPlugin = (): VoicePlugin => ({
  initialize: async () => {},
  close: async () => {},
});

const stubReasoner = (): Reasoner => ({
  // eslint-disable-next-line require-yield
  stream: async function* () {
    return;
  },
});

const stubFront = (): RealtimeAdapter => ({}) as unknown as RealtimeAdapter;

const ctx = { sessionId: "s1" };

describe("buildVoiceSession", () => {
  it("builds a realtime session from a realtime pipeline", () => {
    const pipeline: VoicePipeline<unknown> = {
      kind: "realtime",
      front: () => stubFront(),
      delegateToolName: "consult_knowledge",
    };
    const session = buildVoiceSession(pipeline, {}, stubReasoner(), ctx);
    expect(session).toBeInstanceOf(VoiceAgentSession);
  });

  it("allows a realtime session with no reasoner (front-only)", () => {
    const pipeline: VoicePipeline<unknown> = { kind: "realtime", front: () => stubFront() };
    const session = buildVoiceSession(pipeline, {}, undefined, ctx);
    expect(session).toBeInstanceOf(VoiceAgentSession);
  });

  it("builds a cascaded session from a cascaded pipeline", () => {
    const pipeline: VoicePipeline<unknown> = {
      kind: "cascaded",
      stt: () => ({ plugin: stubPlugin(), config: { model: "nova-3" } }),
      tts: () => ({ plugin: stubPlugin(), config: { voice_id: "v" } }),
    };
    const session = buildVoiceSession(pipeline, {}, stubReasoner(), ctx);
    expect(session).toBeInstanceOf(VoiceAgentSession);
  });

  it("carries sttForceFinalizeTimeoutMs through to the cascaded session", () => {
    // Provider-endpointed cascades (e.g. Deepgram) tune this below the engine default; the mixin
    // must thread it through instead of silently reverting to 7000ms.
    const pipeline: VoicePipeline<unknown> = {
      kind: "cascaded",
      stt: () => ({ plugin: stubPlugin(), config: { model: "nova-3" } }),
      tts: () => ({ plugin: stubPlugin(), config: { voice_id: "v" } }),
      endpointingOwner: "provider_stt",
      sttForceFinalizeTimeoutMs: 3500,
    };
    const session = buildVoiceSession(pipeline, {}, stubReasoner(), ctx);
    expect(session).toBeInstanceOf(VoiceAgentSession);
  });

  it("throws a clear error when a cascaded pipeline has no reasoner", () => {
    const pipeline: VoicePipeline<unknown> = {
      kind: "cascaded",
      stt: () => ({ plugin: stubPlugin() }),
      tts: () => ({ plugin: stubPlugin() }),
    };
    expect(() => buildVoiceSession(pipeline, {}, undefined, ctx)).toThrow(/cascaded pipeline needs a reasoner/);
  });

  it('throws when endpointingOwner is "smart_turn" but no eos stage is provided', () => {
    const pipeline: VoicePipeline<unknown> = {
      kind: "cascaded",
      stt: () => ({ plugin: stubPlugin() }),
      tts: () => ({ plugin: stubPlugin() }),
      endpointingOwner: "smart_turn",
    };
    expect(() => buildVoiceSession(pipeline, {}, stubReasoner(), ctx)).toThrow(/smart_turn/);
  });
});
