// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PipelineBusImpl } from "./pipeline-bus.js";
import { ProviderFallback, type FallbackProvider } from "./provider-fallback.js";
import type { ConversationMetricPacket } from "./packets.js";

function provider(
  id: string,
  send: FallbackProvider<string, string>["send"],
  healthProbe: FallbackProvider<string, string>["healthProbe"] = async () => true,
): FallbackProvider<string, string> {
  return { id, send, healthProbe };
}

describe("ProviderFallback", () => {
  it("falls through unavailable providers and emits availability metrics", async () => {
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const metrics: ConversationMetricPacket[] = [];
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    const first = provider("stt.primary", async () => {
      throw new Error("primary down");
    });
    const second = provider("stt.backup", async (req) => `backup:${req}`);
    const fallback = new ProviderFallback([first, second], {
      bus,
      contextId: "turn-1",
      attemptTimeoutMs: 100,
      recoveryProbeIntervalMs: 1000,
    });

    await expect(fallback.send("hello")).resolves.toBe("backup:hello");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(metrics).toContainEqual(expect.objectContaining({
      contextId: "turn-1",
      name: "stt.primary.availability_changed",
      value: "unavailable",
    }));

    fallback.close();
    bus.stop();
    await started;
  });

  it("runs background recovery probes and returns recovered providers to service", async () => {
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const metrics: ConversationMetricPacket[] = [];
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    let primaryHealthy = false;
    const first = provider(
      "tts.primary",
      async () => {
        if (!primaryHealthy) throw new Error("primary down");
        return "primary";
      },
      async () => primaryHealthy,
    );
    const second = provider("tts.backup", async () => "backup");
    const fallback = new ProviderFallback([first, second], {
      bus,
      contextId: "turn-2",
      attemptTimeoutMs: 100,
      recoveryProbeIntervalMs: 10,
    });

    await expect(fallback.send("hello")).resolves.toBe("backup");
    primaryHealthy = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(fallback.send("hello")).resolves.toBe("primary");

    expect(metrics).toContainEqual(expect.objectContaining({
      name: "tts.primary.availability_changed",
      value: "available",
    }));

    fallback.close();
    bus.stop();
    await started;
  });
});
