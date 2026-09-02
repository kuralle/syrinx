// SPDX-License-Identifier: MIT
//
// Media-lane isolation — a slow Main handler must not stall media packets on Route.Media.

import { describe, it, expect, vi } from "vitest";
import { PipelineBusImpl, Route } from "./pipeline-bus.js";
import type { VoicePacket, ConversationMetricPacket } from "./packets.js";

function pkt(kind: string, contextId = "ctx-1"): VoicePacket {
  return { kind, contextId, timestampMs: Date.now() } as VoicePacket;
}

describe("media lane isolation", () => {
  it("dispatches tts.audio on Route.Media while a slow tts.text Main handler is blocked", async () => {
    const bus = new PipelineBusImpl();
    const drain = bus.start();

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    let audioDispatchedAt = -1;
    bus.on(
      "tts.text",
      async () => {
        await slowGate;
      },
      { serial: true },
    );
    bus.on("tts.audio", () => {
      audioDispatchedAt = Date.now();
    });

    bus.push(Route.Main, pkt("tts.text"));
    await new Promise((r) => setTimeout(r, 20));
    const pushAudioAt = Date.now();
    bus.push(Route.Media, pkt("tts.audio"));
    await new Promise((r) => setTimeout(r, 80));

    expect(audioDispatchedAt).toBeGreaterThan(0);
    expect(audioDispatchedAt - pushAudioAt).toBeLessThan(200);

    releaseSlow();
    await new Promise((r) => setTimeout(r, 20));
    bus.stop();
    await drain;
  });

  it("dispatches user.audio_received on Route.Media while a slow Main handler is blocked", async () => {
    const bus = new PipelineBusImpl();
    const drain = bus.start();

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    let audioDispatchedAt = -1;
    bus.on(
      "eos.turn_complete",
      async () => {
        await slowGate;
      },
      { serial: true },
    );
    bus.on("user.audio_received", () => {
      audioDispatchedAt = Date.now();
    });

    bus.push(Route.Main, pkt("eos.turn_complete"));
    await new Promise((r) => setTimeout(r, 20));
    const pushAudioAt = Date.now();
    bus.push(Route.Media, pkt("user.audio_received"));
    await new Promise((r) => setTimeout(r, 80));

    expect(audioDispatchedAt).toBeGreaterThan(0);
    expect(audioDispatchedAt - pushAudioAt).toBeLessThan(200);

    releaseSlow();
    await new Promise((r) => setTimeout(r, 20));
    bus.stop();
    await drain;
  });

  it("warns once per media kind pushed on Route.Main in dev", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = new PipelineBusImpl();

    bus.push(Route.Main, pkt("tts.audio"));
    bus.push(Route.Main, pkt("tts.audio"));
    bus.push(Route.Main, pkt("user.audio_received"));

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("media queue drops oldest on overflow without throwing", async () => {
    const dropped: VoicePacket[] = [];
    const metrics: string[] = [];
    const dispatched: string[] = [];
    const bus = new PipelineBusImpl({
      mediaCapacity: 2,
      onMediaDrop: (d) => {
        dropped.push(d);
      },
    });

    let releaseMedia!: () => void;
    const mediaGate = new Promise<void>((resolve) => {
      releaseMedia = resolve;
    });

    bus.on(
      "tts.audio",
      async (p) => {
        dispatched.push(p.contextId);
        await mediaGate;
      },
      { serial: true },
    );
    bus.on("metric.conversation", (p) => {
      metrics.push((p as ConversationMetricPacket).name);
    });

    const drain = bus.start();
    bus.push(Route.Media, pkt("tts.audio", "pkt-1"));
    await new Promise((r) => setTimeout(r, 20));

    expect(() => {
      bus.push(Route.Media, pkt("tts.audio", "pkt-2"));
      bus.push(Route.Media, pkt("tts.audio", "pkt-3"));
      bus.push(Route.Media, pkt("tts.audio", "pkt-4"));
    }).not.toThrow();

    expect(dropped.some((d) => d.contextId === "pkt-2")).toBe(true);

    releaseMedia();
    await new Promise((r) => setTimeout(r, 80));
    bus.stop();
    await drain;

    expect(metrics.filter((n) => n === "pipeline.bus.media.dropped").length).toBeGreaterThanOrEqual(1);
    expect(dispatched).toContain("pkt-1");
    expect(dispatched).toContain("pkt-3");
    expect(dispatched).toContain("pkt-4");
    expect(dispatched).not.toContain("pkt-2");
  });
});
