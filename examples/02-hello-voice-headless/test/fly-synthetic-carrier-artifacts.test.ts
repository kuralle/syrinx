// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  validateDownloadedFlySyntheticCarrierArtifacts,
  type FlySpikeSummary,
} from "../scripts/run-fly-synthetic-carrier-spike.js";

describe("Fly synthetic carrier artifact validation", () => {
  it("accepts complete downloaded bot and carrier evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "syrinx-fly-artifacts-"));
    const summary = await writeProviderEvidence(root, "twilio");

    await expect(validateDownloadedFlySyntheticCarrierArtifacts(summary, root)).resolves.toStrictEqual([]);
  });

  it("rejects missing recorder event streams", async () => {
    const root = await mkdtemp(join(tmpdir(), "syrinx-fly-artifacts-"));
    const summary = await writeProviderEvidence(root, "twilio", { omitEvents: true });

    const failures = await validateDownloadedFlySyntheticCarrierArtifacts(summary, root);

    expect(failures).toContain("twilio bot events.jsonl was not downloaded");
  });

  it("rejects carrier WAVs with the wrong sample rate", async () => {
    const root = await mkdtemp(join(tmpdir(), "syrinx-fly-artifacts-"));
    const summary = await writeProviderEvidence(root, "smartpbx", { carrierSampleRateHz: 16000 });

    const failures = await validateDownloadedFlySyntheticCarrierArtifacts(summary, root);

    expect(failures).toContain("smartpbx carrier-inbound.wav sample rate 16000 did not match expected 8000");
    expect(failures).toContain("smartpbx carrier-outbound.wav sample rate 16000 did not match expected 8000");
  });
});

async function writeProviderEvidence(
  root: string,
  provider: "twilio" | "telnyx" | "smartpbx",
  options: {
    readonly omitEvents?: boolean;
    readonly carrierSampleRateHz?: number;
  } = {},
): Promise<FlySpikeSummary> {
  const session = `${provider}-session`;
  const botBase = `test/performance/runs/fly-synthetic-carrier-test/bot-artifacts/${provider}/${session}`;
  const carrierBase = `test/performance/runs/fly-synthetic-carrier-test/carrier-artifacts/${provider}`;
  const botDir = join(root, botBase);
  const carrierDir = join(root, carrierBase);
  await mkdir(botDir, { recursive: true });
  await mkdir(carrierDir, { recursive: true });

  const userPcm = Buffer.alloc(3200, 1);
  const assistantPcm = Buffer.alloc(6400, 2);
  await writeFile(join(botDir, "user_audio.pcm"), userPcm);
  await writeFile(join(botDir, "assistant_audio.pcm"), assistantPcm);
  await writePcm16Wav(join(botDir, "user_audio.wav"), 16000, 1600);
  await writePcm16Wav(join(botDir, "assistant_audio.wav"), 16000, 3200);
  await writeJson(join(botDir, "manifest.json"), {
    schemaVersion: 1,
    audio: {
      user: { sampleRateHz: 16000, byteLength: userPcm.byteLength, chunks: 2 },
      assistant: { sampleRateHz: 16000, byteLength: assistantPcm.byteLength, chunks: 3, truncations: 0 },
    },
    events: { packets: 4, byteLength: 256 },
  });
  if (!options.omitEvents) {
    await writeFile(join(botDir, "events.jsonl"), [
      jsonLine("stt.result"),
      jsonLine("llm.delta"),
      jsonLine("tts.audio"),
      jsonLine("record.assistant_audio"),
    ].join(""));
  }

  await writeJson(join(carrierDir, "call-result.json"), callResult(provider));
  await writePcm16Wav(join(carrierDir, "carrier-inbound.wav"), options.carrierSampleRateHz ?? 8000, 800);
  await writePcm16Wav(join(carrierDir, "carrier-outbound.wav"), options.carrierSampleRateHz ?? 8000, 800);

  return {
    scenario: "fly_synthetic_public_carrier_to_bot",
    generatedAt: "2026-05-29T00:00:00.000Z",
    region: "sin",
    memoryMb: 1024,
    networkProfile: "jittery",
    apps: { bot: "bot", carrier: "carrier" },
    urls: { botBaseUrl: "https://bot.fly.dev", carrierBaseUrl: "https://carrier.fly.dev" },
    providers: [
      {
        provider,
        callResult: callResult(provider),
        botArtifacts: options.omitEvents
          ? [
              `${botBase}/assistant_audio.pcm`,
              `${botBase}/assistant_audio.wav`,
              `${botBase}/manifest.json`,
              `${botBase}/user_audio.pcm`,
              `${botBase}/user_audio.wav`,
            ]
          : [
              `${botBase}/assistant_audio.pcm`,
              `${botBase}/assistant_audio.wav`,
              `${botBase}/events.jsonl`,
              `${botBase}/manifest.json`,
              `${botBase}/user_audio.pcm`,
              `${botBase}/user_audio.wav`,
            ],
        carrierArtifacts: [
          `${carrierBase}/call-result.json`,
          `${carrierBase}/carrier-inbound.wav`,
          `${carrierBase}/carrier-outbound.wav`,
        ],
      },
    ],
    artifacts: {
      runDir: "test/performance/runs/fly-synthetic-carrier-test",
      summaryPath: "test/performance/runs/fly-synthetic-carrier-test/summary.json",
    },
    cleanup: { botDestroyed: true, carrierDestroyed: true },
  };
}

function callResult(provider: "twilio" | "telnyx" | "smartpbx"): Record<string, unknown> {
  return {
    provider,
    carrier: {
      inboundFrames: 10,
      inboundWireBytes: 1600,
      outboundFrames: 12,
      outboundWireBytes: 1920,
      maxInboundMediaGapMs: 40,
      firstOutboundMediaAfterStartMs: 900,
      outboundEndMarks: provider === "smartpbx" ? 0 : 1,
      outboundQuietDrains: provider === "smartpbx" ? 1 : 0,
      localPlayoutDrains: 0,
    },
    qualityGate: { passed: true, failures: [] },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function jsonLine(kind: string): string {
  return `${JSON.stringify({ kind, packet: { kind } })}\n`;
}

async function writePcm16Wav(path: string, sampleRateHz: number, sampleCount: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRateHz, 24);
  buffer.writeUInt32LE(sampleRateHz * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  await writeFile(path, buffer);
}
