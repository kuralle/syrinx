// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { VoiceAgentSession } from "./voice-agent-session.js";
import {
  Route,
  TurnSegmentation,
  type InteractionDecision,
  type InteractionObservation,
  type InteractionPolicy,
  type LlmErrorPacket,
  type PipelineBus,
  type PluginConfig,
  type VoicePlugin,
  type UserInputPacket,
  type LlmResponseDonePacket,
} from "./index.js";
import type {
  EndOfSpeechPacket,
  InterruptionDetectedPacket,
  LlmDeltaPacket,
  LlmResponseDonePacket as LlmDonePkt,
  SttInterimPacket,
  SttPartialPacket,
  SttResultPacket,
  TextToSpeechPlayoutProgressPacket,
} from "./packets.js";

class BackchannelPolicy implements InteractionPolicy {
  observe(obs: InteractionObservation): readonly InteractionDecision[] {
    if (obs.kind === "stt_final" && obs.text.trim() === "mm-hmm") {
      return [{ kind: "backchannel", cue: "mm_hmm" }];
    }
    return [];
  }

  reset(_contextId: string): void {
    // no-op
  }
}

class HistoryTrackingBridge implements VoicePlugin {
  readonly history: Array<{ role: "user" | "assistant"; content: string }> = [];

  async initialize(bus: PipelineBus): Promise<void> {
    bus.on("user.input", (pkt) => {
      this.history.push({ role: "user", content: (pkt as UserInputPacket).text });
    });
    bus.on("llm.done", (pkt) => {
      this.history.push({ role: "assistant", content: (pkt as LlmResponseDonePacket).text });
    });
  }

  async close(): Promise<void> {
    // no-op
  }
}

function assistantId(contextId: string, epoch = 1) {
  return { contextId, iuId: `${contextId}#assistant`, epoch };
}

async function closeSession(session: VoiceAgentSession): Promise<void> {
  if (session.state !== "closed") await session.close();
}

describe("iu-segmentation", () => {
  it("stamps every transcript emission with a ledger id", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const partials: Array<{ iuId: unknown }> = [];
    const finals: Array<{ iuId: unknown }> = [];
    const deltas: Array<{ iuId: unknown }> = [];
    const finished: Array<{ iuId: unknown }> = [];

    await session.start();
    session.on("user_input_partial", (event) => partials.push(event));
    session.on("user_input_final", (event) => finals.push(event));
    session.on("agent_text_delta", (event) => deltas.push(event));
    session.on("agent_finished", (event) => finished.push(event));

    session.bus.push(Route.Main, {
      kind: "stt.interim",
      contextId: "turn-1",
      timestampMs: 100,
      text: "hello",
    } satisfies SttInterimPacket);
    session.bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-1",
      timestampMs: 200,
      text: "hello",
      confidence: 0.95,
    } satisfies SttResultPacket);
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: 250,
      text: "hello",
      transcripts: [],
    } satisfies EndOfSpeechPacket);
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "turn-1",
      timestampMs: 300,
      text: "Hi there.",
    } satisfies LlmDeltaPacket);
    session.bus.push(Route.Main, {
      kind: "llm.done",
      contextId: "turn-1",
      timestampMs: 400,
      text: "Hi there.",
    } satisfies LlmDonePkt);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(partials).toHaveLength(1);
    expect(partials[0]?.iuId).toEqual({ contextId: "turn-1", iuId: "turn-1", epoch: 1 });
    expect(finals).toHaveLength(2);
    for (const event of finals) {
      expect(event.iuId).toEqual({ contextId: "turn-1", iuId: "turn-1", epoch: 1 });
    }
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.iuId).toEqual({ contextId: "turn-1", iuId: "turn-1#assistant", epoch: 1 });
    expect(finished).toHaveLength(1);
    expect(finished[0]?.iuId).toEqual({ contextId: "turn-1", iuId: "turn-1#assistant", epoch: 1 });

    await closeSession(session);
  });

  it("backchannel InteractionDecision creates zero ledger entries and zero bridge history", async () => {
    const bridge = new HistoryTrackingBridge();
    const session = new VoiceAgentSession({
      plugins: {},
      interactionPolicy: new BackchannelPolicy(),
    });
    session.registerPlugin("bridge", bridge);

    await session.start();

    session.bus.push(Route.Main, {
      kind: "stt.interim",
      contextId: "bc-turn",
      timestampMs: 100,
      text: "mm-hmm",
    } satisfies SttInterimPacket);
    session.bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "bc-turn",
      timestampMs: 200,
      text: "mm-hmm",
      confidence: 0.9,
    } satisfies SttResultPacket);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(session.iuLedger.get({ contextId: "bc-turn", iuId: "bc-turn", epoch: 1 })).toBeUndefined();
    expect(session.iuLedger.get({ contextId: "bc-turn", iuId: "bc-turn#assistant", epoch: 1 })).toBeUndefined();
    expect(bridge.history).toEqual([]);

    await closeSession(session);
  });

  it("barge-in at 400ms commits assistant IU with committedPrefix.ms === 400", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-barge",
      timestampMs: 100,
      text: "question",
      transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "turn-barge",
      timestampMs: 150,
      text: "Long answer text.",
    } satisfies LlmDeltaPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.bus.push(Route.Media, {
      kind: "tts.audio",
      contextId: "turn-barge",
      timestampMs: 200,
      audio: new Uint8Array(64000),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-barge",
      timestampMs: 250,
      playedOutMs: 400,
      complete: false,
    } satisfies TextToSpeechPlayoutProgressPacket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    session.bus.push(Route.Main, {
      kind: "interrupt.detected",
      contextId: "turn-barge",
      timestampMs: 260,
      source: "client",
    } satisfies InterruptionDetectedPacket);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const iu = session.iuLedger.get(assistantId("turn-barge"));
    expect(iu?.state).toBe("committed");
    expect(iu?.committedPrefix?.ms).toBe(400);

    await closeSession(session);
  });

  it("routes ledger anomalies to the observability seam", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const errors: LlmErrorPacket[] = [];

    await session.start();
    session.bus.on("llm.error", (pkt) => {
      errors.push(pkt as LlmErrorPacket);
    });

    const id = { contextId: "anomaly-ctx", iuId: "anomaly-ctx", epoch: 1 };
    session.iuLedger.add({ id, kind: "user_turn", state: "hypothesized" });
    session.iuLedger.commit(id);
    session.iuLedger.commit(id);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: "llm.error",
      component: "iu_ledger",
      contextId: "anomaly-ctx",
    });
    expect(errors[0]?.cause.message).toContain("terminal_op");

    await closeSession(session);
  });
});

describe("iu-segmentation guard bites", () => {
  it("backchannel exclusion fails when markBackchannel is removed (sabotage: iu-segmentation.test.ts:backchannel)", async () => {
    const segmentation = new TurnSegmentation(vi.fn());
    segmentation.onSttPartial("bc-turn");
    expect(segmentation.countEntries()).toBe(1);

    segmentation.markBackchannel("bc-turn");
    expect(segmentation.countEntries()).toBe(0);

    // Sabotage: skip markBackchannel — entry survives incorrectly.
    const bad = new TurnSegmentation(vi.fn());
    bad.onSttPartial("bc-turn");
    expect(bad.countEntries()).toBe(1);
  });

  it("barge-in prefix fails when onAssistantBargeIn is skipped (sabotage: iu-segmentation.test.ts:barge-in)", async () => {
    const segmentation = new TurnSegmentation(vi.fn());
    segmentation.onAssistantResponseStart("turn-barge");
    segmentation.onAssistantBargeIn("turn-barge", 400);
    expect(segmentation.ledger.get(assistantId("turn-barge"))?.committedPrefix?.ms).toBe(400);

    const bad = new TurnSegmentation(vi.fn());
    bad.onAssistantResponseStart("turn-barge");
    expect(bad.ledger.get(assistantId("turn-barge"))?.committedPrefix?.ms).toBeUndefined();
  });
});
