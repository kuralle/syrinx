// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PipelineBusImpl, Route } from "./pipeline-bus.js";
import { InMemoryMetricsExporter } from "./observability.js";
import { ObservabilityObserver } from "./observability-observer.js";
import type {
  TurnBoundaryEventPacket,
  VadSpeechStartedPacket,
  VadSpeechEndedPacket,
  EndOfSpeechPacket,
  TextToSpeechAudioPacket,
  TextToSpeechEndPacket,
  InterruptionDetectedPacket,
} from "./packets.js";

async function drainBus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function withObserver(
  fn: (ctx: {
    bus: PipelineBusImpl;
    exporter: InMemoryMetricsExporter;
    boundaries: TurnBoundaryEventPacket[];
  }) => void | Promise<void>,
): Promise<void> {
  const bus = new PipelineBusImpl();
  const exporter = new InMemoryMetricsExporter();
  const boundaries: TurnBoundaryEventPacket[] = [];
  bus.on("obs.turn_boundary", (pkt) => {
    boundaries.push(pkt as TurnBoundaryEventPacket);
  });

  const observer = new ObservabilityObserver({
    bus,
    exporter,
    sessionId: "sess-1",
    dims: { provider: "p1", model: "m1", region: "r1" },
    getContextId: () => "",
  });
  observer.wire();

  const startP = bus.start();
  await new Promise((r) => setTimeout(r, 5));
  await fn({ bus, exporter, boundaries });
  await drainBus();
  bus.stop();
  await startP;
  observer.dispose();
}

const SPEECH_ID = "turn-abc";

describe("ObservabilityObserver", () => {
  it("emits turn boundaries and v2v_ms histogram for a full turn", async () => {
    await withObserver(async ({ bus, exporter, boundaries }) => {
      bus.push(Route.Main, {
        kind: "vad.speech_started",
        contextId: SPEECH_ID,
        timestampMs: 1000,
        confidence: 0.9,
      } satisfies VadSpeechStartedPacket);

      bus.push(Route.Main, {
        kind: "vad.speech_ended",
        contextId: SPEECH_ID,
        timestampMs: 1100,
      } satisfies VadSpeechEndedPacket);

      bus.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId: SPEECH_ID,
        timestampMs: 1200,
        text: "hello",
        transcripts: [],
      } satisfies EndOfSpeechPacket);

      bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: SPEECH_ID,
        timestampMs: 1300,
        audio: new Uint8Array(320),
        sampleRateHz: 16000,
      } satisfies TextToSpeechAudioPacket);

      bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: SPEECH_ID,
        timestampMs: 1400,
        audio: new Uint8Array(320),
        sampleRateHz: 16000,
      } satisfies TextToSpeechAudioPacket);

      bus.push(Route.Main, {
        kind: "tts.end",
        contextId: SPEECH_ID,
        timestampMs: 1500,
      } satisfies TextToSpeechEndPacket);
      await drainBus();

      const kinds = boundaries.map((b) => b.boundary);
      expect(kinds).toEqual([
        "user_started_speaking",
        "user_stopped_speaking",
        "agent_thinking",
        "agent_started_speaking",
        "agent_audio_done",
      ]);

      for (const b of boundaries) {
        expect(b.kind).toBe("obs.turn_boundary");
        expect(b.sessionId).toBe("sess-1");
        expect(b.speechId).toBe(SPEECH_ID);
        expect(b.provider).toBe("p1");
        expect(b.model).toBe("m1");
        expect(b.region).toBe("r1");
        expect(b.monotonicMs).toBeGreaterThan(0);
        expect(b.cancelled).toBeUndefined();
      }

      const v2v = exporter.histograms.find((h) => h.name === "v2v_ms");
      expect(v2v).toBeDefined();
      expect(v2v!.valueMs).toBeGreaterThanOrEqual(0);
      expect(v2v!.tags).toEqual({
        sessionId: "sess-1",
        speechId: SPEECH_ID,
        provider: "p1",
        model: "m1",
        region: "r1",
        cancelled: "false",
      });

      const thinking = exporter.histograms.find((h) => h.name === "thinking_ms");
      expect(thinking).toBeDefined();
      expect(thinking!.valueMs).toBeGreaterThanOrEqual(0);

      const agentSpeech = exporter.histograms.find((h) => h.name === "agent_speech_ms");
      expect(agentSpeech).toBeDefined();
      expect(agentSpeech!.valueMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("tags interruption boundary and histograms as cancelled", async () => {
    await withObserver(async ({ bus, exporter, boundaries }) => {
      bus.push(Route.Critical, {
        kind: "interrupt.detected",
        contextId: SPEECH_ID,
        timestampMs: 2000,
        source: "vad",
      } satisfies InterruptionDetectedPacket);
      await drainBus();

      const interruption = boundaries.find((b) => b.boundary === "interruption");
      expect(interruption).toBeDefined();
      expect(interruption!.cancelled).toBe(true);

      const withCancelled = exporter.histograms.filter((h) => h.tags.cancelled === "true");
      for (const h of withCancelled) {
        expect(h.tags).toMatchObject({
          sessionId: "sess-1",
          speechId: SPEECH_ID,
          cancelled: "true",
        });
      }
    });
  });

  it("emits agent_started_speaking only once per speechId", async () => {
    await withObserver(async ({ bus, boundaries }) => {
      bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: SPEECH_ID,
        timestampMs: 100,
        audio: new Uint8Array(4),
        sampleRateHz: 16000,
      } satisfies TextToSpeechAudioPacket);
      bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: SPEECH_ID,
        timestampMs: 200,
        audio: new Uint8Array(4),
        sampleRateHz: 16000,
      } satisfies TextToSpeechAudioPacket);
      await drainBus();

      const started = boundaries.filter((b) => b.boundary === "agent_started_speaking");
      expect(started).toHaveLength(1);
    });
  });

  it("uses provider/model/region dimensions from STT and TTS packets when present", async () => {
    await withObserver(async ({ bus, exporter, boundaries }) => {
      bus.push(Route.Main, {
        kind: "vad.speech_ended",
        contextId: SPEECH_ID,
        timestampMs: 1100,
      } satisfies VadSpeechEndedPacket);
      bus.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId: SPEECH_ID,
        timestampMs: 1200,
        text: "hello",
        transcripts: [
          {
            kind: "stt.result",
            contextId: SPEECH_ID,
            timestampMs: 1190,
            text: "hello",
            confidence: 0.9,
            provider: { name: "deepgram", model: "nova-3", region: "global" },
          },
        ],
      } satisfies EndOfSpeechPacket);
      bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: SPEECH_ID,
        timestampMs: 1300,
        audio: new Uint8Array(320),
        sampleRateHz: 16000,
        provider: { name: "cartesia", model: "sonic-3", region: "global", cancelled: false },
      } satisfies TextToSpeechAudioPacket);
      await drainBus();

      const started = boundaries.find((b) => b.boundary === "agent_started_speaking");
      expect(started).toMatchObject({
        provider: "cartesia",
        model: "sonic-3",
        region: "global",
      });
      const thinking = boundaries.find((b) => b.boundary === "agent_thinking");
      expect(thinking).toMatchObject({
        provider: "deepgram",
        model: "nova-3",
        region: "global",
      });
      expect(exporter.histograms.find((h) => h.name === "v2v_ms")?.tags).toMatchObject({
        provider: "cartesia",
        model: "sonic-3",
        region: "global",
        speechId: SPEECH_ID,
      });
    });
  });
});
