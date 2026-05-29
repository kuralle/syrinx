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

  it("rejects recorder manifests that fail the recorder artifact contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "syrinx-fly-artifacts-"));
    const summary = await writeProviderEvidence(root, "telnyx", { recorderAssistantDurationMs: 1 });

    const failures = await validateDownloadedFlySyntheticCarrierArtifacts(summary, root);

    expect(failures).toContain(
      "telnyx bot manifest audio.assistant.durationMs 1 did not match 200 from byte count/sample rate",
    );
  });

  it("rejects contradictory carrier quality gate evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "syrinx-fly-artifacts-"));
    const summary = await writeProviderEvidence(root, "twilio", { qualityGateFailures: ["carrier outbound audio was empty"] });

    const failures = await validateDownloadedFlySyntheticCarrierArtifacts(summary, root);

    expect(failures).toContain("twilio qualityGate.passed cannot be true when qualityGate.failures is non-empty");
  });

  it("rejects downloaded carrier call result drift from the summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "syrinx-fly-artifacts-"));
    const summary = await writeProviderEvidence(root, "telnyx", { downloadedOutboundFrames: 1 });

    const failures = await validateDownloadedFlySyntheticCarrierArtifacts(summary, root);

    expect(failures).toContain("telnyx carrier call-result.json did not match summary callResult");
  });

  it("rejects carrier WAV data length that disagrees with decoded carrier metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "syrinx-fly-artifacts-"));
    const summary = await writeProviderEvidence(root, "smartpbx", { carrierOutboundSampleCount: 400 });

    const failures = await validateDownloadedFlySyntheticCarrierArtifacts(summary, root);

    expect(failures).toContain("smartpbx carrier-outbound.wav data byte length 800 did not match expected 1600");
  });
});

async function writeProviderEvidence(
  root: string,
  provider: "twilio" | "telnyx" | "smartpbx",
  options: {
    readonly omitEvents?: boolean;
    readonly carrierSampleRateHz?: number;
    readonly recorderAssistantDurationMs?: number;
    readonly qualityGateFailures?: string[];
    readonly downloadedOutboundFrames?: number;
    readonly carrierOutboundSampleCount?: number;
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
    sessionId: session,
    startedAtMs: 1000,
    closedAtMs: 2000,
    files: {
      directory: botDir,
      eventsPath: join(botDir, "events.jsonl"),
      userAudioPath: join(botDir, "user_audio.pcm"),
      assistantAudioPath: join(botDir, "assistant_audio.pcm"),
      manifestPath: join(botDir, "manifest.json"),
    },
    audio: {
      user: {
        path: join(botDir, "user_audio.pcm"),
        sampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: userPcm.byteLength,
        durationMs: 100,
        chunks: 2,
      },
      assistant: {
        path: join(botDir, "assistant_audio.pcm"),
        sampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: assistantPcm.byteLength,
        durationMs: options.recorderAssistantDurationMs ?? 200,
        chunks: 3,
        truncations: 0,
      },
    },
    events: { path: join(botDir, "events.jsonl"), packets: 4, byteLength: 256 },
  });
  if (!options.omitEvents) {
    await writeFile(join(botDir, "events.jsonl"), [
      jsonLine("stt.result"),
      jsonLine("llm.delta"),
      jsonLine("tts.audio"),
      jsonLine("record.assistant_audio"),
    ].join(""));
  }

  await writeJson(join(carrierDir, "call-result.json"), callResult(provider, [], {
    outboundFrames: options.downloadedOutboundFrames,
  }));
  await writePcm16Wav(join(carrierDir, "carrier-inbound.wav"), options.carrierSampleRateHz ?? 8000, 800);
  await writePcm16Wav(join(carrierDir, "carrier-outbound.wav"), options.carrierSampleRateHz ?? 8000, options.carrierOutboundSampleCount ?? 800);

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
        callResult: callResult(provider, options.qualityGateFailures),
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

function callResult(
  provider: "twilio" | "telnyx" | "smartpbx",
  qualityGateFailures: string[] = [],
  overrides: { readonly outboundFrames?: number } = {},
): Record<string, unknown> {
  return {
    provider,
    carrier: {
      inboundFrames: 10,
      inboundWireBytes: 1600,
      inboundDecodedPcmBytes: 1600,
      outboundFrames: overrides.outboundFrames ?? 12,
      outboundWireBytes: 1920,
      outboundDecodedPcmBytes: 1600,
      maxInboundMediaGapMs: 40,
      firstOutboundMediaAfterStartMs: 900,
      outboundEndMarks: provider === "smartpbx" ? 0 : 1,
      outboundQuietDrains: provider === "smartpbx" ? 1 : 0,
      localPlayoutDrains: 0,
    },
    qualityGate: { passed: true, failures: qualityGateFailures },
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
