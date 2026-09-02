// SPDX-License-Identifier: MIT

import { describe, it, expect, vi, afterEach } from "vitest";
import { VoiceAgentSession, type Reasoner, type VoicePlugin } from "@kuralle-syrinx/core";
import * as core from "@kuralle-syrinx/core";
import * as realtimeModule from "@kuralle-syrinx/realtime";
import type { RealtimeAdapter } from "@kuralle-syrinx/realtime";
import { buildVoiceSession, resolveVoiceShape, type VoicePipelineFields } from "./build-session.js";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveVoiceShape", () => {
  it('resolves "realtime" when only `realtime` is populated', () => {
    expect(resolveVoiceShape({ realtime: () => stubFront() })).toBe("realtime");
  });

  it('resolves "half_cascade" when `realtime` + `tts` are populated', () => {
    expect(
      resolveVoiceShape({
        realtime: () => stubFront(),
        tts: () => ({ plugin: stubPlugin() }),
      }),
    ).toBe("half_cascade");
  });

  it('resolves "cascade" when `stt` + `tts` are populated', () => {
    expect(
      resolveVoiceShape({
        stt: () => ({ plugin: stubPlugin() }),
        tts: () => ({ plugin: stubPlugin() }),
      }),
    ).toBe("cascade");
  });

  it("throws naming `stt` when `realtime` and `stt` are both populated (realtime owns input)", () => {
    expect(() =>
      resolveVoiceShape({
        realtime: () => stubFront(),
        stt: () => ({ plugin: stubPlugin() }),
      }),
    ).toThrow("withVoice: `realtime` owns input; remove `stt`");
  });

  it("throws naming the missing field when only `stt` is populated", () => {
    expect(() => resolveVoiceShape({ stt: () => ({ plugin: stubPlugin() }) })).toThrow(
      "withVoice: a cascade needs both `stt` and `tts`; got stt only",
    );
  });

  it("throws naming the missing field when only `tts` is populated", () => {
    expect(() => resolveVoiceShape({ tts: () => ({ plugin: stubPlugin() }) })).toThrow(
      "withVoice: a cascade needs both `stt` and `tts`; got tts only",
    );
  });

  it("throws naming a cascade-only knob supplied to a realtime front", () => {
    expect(() =>
      resolveVoiceShape({
        realtime: () => stubFront(),
        vad: () => ({ plugin: stubPlugin() }),
        speculative: true,
      }),
    ).toThrow("withVoice: `vad`, `speculative` only applies to a cascade (`stt` + `tts`); remove it from this realtime configuration");
  });

  it("throws naming a realtime-only knob supplied to a cascade", () => {
    expect(() =>
      resolveVoiceShape({
        stt: () => ({ plugin: stubPlugin() }),
        tts: () => ({ plugin: stubPlugin() }),
        renderDirective: "translate_faithfully",
      }),
    ).toThrow("withVoice: `renderDirective` only applies to a `realtime` front; remove it from this cascade configuration");
  });

  it("throws when no shape field is populated", () => {
    expect(() => resolveVoiceShape({})).toThrow("withVoice: provide `realtime`, or `stt` + `tts`");
  });
});

describe("buildVoiceSession", () => {
  it("builds a realtime session from `realtime`", () => {
    const fields: VoicePipelineFields<unknown> = {
      realtime: () => stubFront(),
      delegateToolName: "consult_knowledge",
    };
    const session = buildVoiceSession(fields, {}, stubReasoner(), ctx);
    expect(session).toBeInstanceOf(VoiceAgentSession);
  });

  it("allows a realtime session with no reasoner (front-only)", () => {
    const fields: VoicePipelineFields<unknown> = { realtime: () => stubFront() };
    const session = buildVoiceSession(fields, {}, undefined, ctx);
    expect(session).toBeInstanceOf(VoiceAgentSession);
  });

  it("builds a cascaded session from `stt` + `tts`", () => {
    const fields: VoicePipelineFields<unknown> = {
      stt: () => ({ plugin: stubPlugin(), config: { model: "nova-3" } }),
      tts: () => ({ plugin: stubPlugin(), config: { voice_id: "v" } }),
    };
    const session = buildVoiceSession(fields, {}, stubReasoner(), ctx);
    expect(session).toBeInstanceOf(VoiceAgentSession);
  });

  it("carries sttForceFinalizeTimeoutMs through to the cascaded session", () => {
    // Provider-endpointed cascades (e.g. Deepgram) tune this below the engine default; the mixin
    // must thread it through instead of silently reverting to 7000ms.
    const fields: VoicePipelineFields<unknown> = {
      stt: () => ({ plugin: stubPlugin(), config: { model: "nova-3" } }),
      tts: () => ({ plugin: stubPlugin(), config: { voice_id: "v" } }),
      endpointingOwner: "provider_stt",
      sttForceFinalizeTimeoutMs: 3500,
    };
    const session = buildVoiceSession(fields, {}, stubReasoner(), ctx);
    expect(session).toBeInstanceOf(VoiceAgentSession);
  });

  it("throws a clear error when a cascaded pipeline has no reasoner", () => {
    const fields: VoicePipelineFields<unknown> = {
      stt: () => ({ plugin: stubPlugin() }),
      tts: () => ({ plugin: stubPlugin() }),
    };
    expect(() => buildVoiceSession(fields, {}, undefined, ctx)).toThrow(/cascaded pipeline needs a reasoner/);
  });

  it('throws when endpointingOwner is "smart_turn" but no eos stage is provided', () => {
    const fields: VoicePipelineFields<unknown> = {
      stt: () => ({ plugin: stubPlugin() }),
      tts: () => ({ plugin: stubPlugin() }),
      endpointingOwner: "smart_turn",
    };
    expect(() => buildVoiceSession(fields, {}, stubReasoner(), ctx)).toThrow(/smart_turn/);
  });

  it("resolves endpointingOwner when provided as an (env) => owner factory", () => {
    let seenEnv: { ai: boolean } | undefined;
    const fields: VoicePipelineFields<{ ai: boolean }> = {
      stt: () => ({ plugin: stubPlugin() }),
      tts: () => ({ plugin: stubPlugin() }),
      endpointingOwner: (env) => {
        seenEnv = env;
        return env.ai ? "smart_turn" : "provider_stt";
      },
    };

    const providerSession = buildVoiceSession(fields, { ai: false }, stubReasoner(), ctx);
    expect(providerSession).toBeInstanceOf(VoiceAgentSession);
    expect(seenEnv).toEqual({ ai: false });

    expect(() => buildVoiceSession(fields, { ai: true }, stubReasoner(), ctx)).toThrow(/smart_turn/);
  });

  it("builds smart_turn when the factory returns smart_turn and eos is present", () => {
    const fields: VoicePipelineFields<{ ai: boolean }> = {
      stt: () => ({ plugin: stubPlugin() }),
      tts: () => ({ plugin: stubPlugin() }),
      eos: () => ({ plugin: stubPlugin(), config: {} }),
      endpointingOwner: (env) => (env.ai ? "smart_turn" : "provider_stt"),
    };
    const session = buildVoiceSession(fields, { ai: true }, stubReasoner(), ctx);
    expect(session).toBeInstanceOf(VoiceAgentSession);
  });

  it("treats an eos factory that returns undefined as no eos stage", () => {
    const fields: VoicePipelineFields<unknown> = {
      stt: () => ({ plugin: stubPlugin() }),
      tts: () => ({ plugin: stubPlugin() }),
      eos: () => undefined,
      endpointingOwner: "provider_stt",
    };
    expect(buildVoiceSession(fields, {}, stubReasoner(), ctx)).toBeInstanceOf(VoiceAgentSession);
  });

  it("half-cascade (`realtime` + `tts`): assembles `plugins: { realtime, tts }`, endpointingOwner \"timer\", and a textOnly bridge", () => {
    // vi.spyOn's default call-through does not preserve `new`-invocability for a class
    // export, so the spy explicitly reconstructs through the real class via Reflect.construct.
    const RealVoiceAgentSession = core.VoiceAgentSession;
    const sessionSpy = vi
      .spyOn(core, "VoiceAgentSession")
      .mockImplementation((...args: unknown[]) => Reflect.construct(RealVoiceAgentSession, args) as VoiceAgentSession);
    const RealRealtimeBridge = realtimeModule.RealtimeBridge;
    const bridgeSpy = vi
      .spyOn(realtimeModule, "RealtimeBridge")
      .mockImplementation((...args: unknown[]) => Reflect.construct(RealRealtimeBridge, args) as InstanceType<typeof RealRealtimeBridge>);
    const front = stubFront();
    const reasoner = stubReasoner();
    const ttsConfig = { voice_id: "v" };
    const ttsPlugin = stubPlugin();

    const fields: VoicePipelineFields<unknown> = {
      realtime: () => front,
      tts: () => ({ plugin: ttsPlugin, config: ttsConfig }),
      delegateToolName: "consult_knowledge",
    };
    const session = buildVoiceSession(fields, {}, reasoner, ctx);
    // Not `toBeInstanceOf(VoiceAgentSession)`: spying on `core.VoiceAgentSession` leaves the
    // top-level import diverged from it in this test — check against the exact class
    // reference passed to Reflect.construct instead.
    expect(session).toBeInstanceOf(RealVoiceAgentSession);

    // plugin map: realtime + tts only — no stt/vad/eos/bridge slot for a half-cascade.
    expect(sessionSpy).toHaveBeenCalledTimes(1);
    const sessionConfig = sessionSpy.mock.calls[0]![0] as { plugins: Record<string, unknown>; endpointingOwner: string };
    expect(sessionConfig.plugins).toEqual({ realtime: {}, tts: ttsConfig });
    expect(sessionConfig.endpointingOwner).toBe("timer");

    // the bridge is constructed textOnly — the front's own audio must never play; the
    // TTS plugin owns playout instead.
    expect(bridgeSpy).toHaveBeenCalledTimes(1);
    const [bridgeFront, bridgeReasoner, bridgeToolName, bridgeOpts] = bridgeSpy.mock.calls[0]!;
    expect(bridgeFront).toBe(front);
    expect(bridgeReasoner).toBe(reasoner);
    expect(bridgeToolName).toBe("consult_knowledge");
    expect(bridgeOpts).toMatchObject({ textOnly: true });
  });

  it("propagates resolveVoiceShape's error for an invalid field combination", () => {
    const fields: VoicePipelineFields<unknown> = { stt: () => ({ plugin: stubPlugin() }) };
    expect(() => buildVoiceSession(fields, {}, stubReasoner(), ctx)).toThrow(
      "withVoice: a cascade needs both `stt` and `tts`; got stt only",
    );
  });
});
