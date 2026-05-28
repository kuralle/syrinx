// SPDX-License-Identifier: MIT

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  validateSmokeArtifactManifest,
  writeSmokeArtifactManifest,
  type SmokeArtifactManifest,
} from "../scripts/smoke-artifact-manifest.js";

describe("smoke artifact manifest", () => {
  it("accepts explicit wire and decoded PCM byte accounting for compressed telephony audio", async () => {
    const manifest = makeTwilioManifest();

    expect(validateSmokeArtifactManifest(manifest)).toStrictEqual([]);

    const dir = await mkdtemp(join(tmpdir(), "syrinx-smoke-manifest-"));
    const path = join(dir, "manifest.json");
    await writeSmokeArtifactManifest(path, manifest);

    const written = JSON.parse(await readFile(path, "utf8")) as SmokeArtifactManifest;
    expect(written.audio.inputWireByteLength).toBe(1120);
    expect(written.audio.inputDecodedPcmByteLength).toBe(4480);
    expect(written.turns[0]?.assistantAudio.wireByteLength).toBe(1920);
    expect(written.turns[0]?.assistantAudio.decodedPcmByteLength).toBe(3840);
  });

  it("rejects schema drift that loses compressed payload provenance", () => {
    const manifest = makeTwilioManifest();
    const bad: SmokeArtifactManifest = {
      ...manifest,
      turns: [
        {
          ...manifest.turns[0]!,
          assistantAudio: {
            ...manifest.turns[0]!.assistantAudio,
            decodedPcmByteLength: undefined,
          },
        },
      ],
    };

    expect(validateSmokeArtifactManifest(bad)).toContain("turn twilio-call assistantAudio.decodedPcmByteLength is required for PCMU audio");
  });

  it("rejects duration math derived from compressed Opus bytes instead of decoded PCM bytes", () => {
    const bad = makeSmartPbxOpusManifest({
      outputDurationMs: 17,
      turnOutputDurationMs: 17,
    });

    expect(validateSmokeArtifactManifest(bad)).toContain("turn smartpbx-call assistantAudio.durationMs 17 did not match 240 from byte count/sample rate");
  });

  it("requires carrier-relative latency fields for telephony transports", () => {
    const manifest = makeTwilioManifest();
    const bad: SmokeArtifactManifest = {
      ...manifest,
      turns: [
        {
          ...manifest.turns[0]!,
          latencyMs: {
            firstOutboundMediaAfterStart: 174,
          },
        },
      ],
    };

    expect(validateSmokeArtifactManifest(bad)).toContain(
      "turn twilio-call latency firstOutboundMediaAfterLastInbound is required for twilio_media_stream_websocket",
    );
  });
});

function makeTwilioManifest(): SmokeArtifactManifest {
  return {
    schemaVersion: 2,
    scenario: "twilio_media_stream_emulated_phone_agent",
    generatedAt: "2026-05-28T00:00:00.000Z",
    transport: "twilio_media_stream_websocket",
    fixtureProvider: "synthetic-pcm-tone",
    run: { runDir: "test/performance/runs/twilio" },
    audio: {
      inputSampleRateHz: 16000,
      outputSampleRateHz: 8000,
      inputByteLength: 4480,
      outputByteLength: 1920,
      inputWireByteLength: 1120,
      outputWireByteLength: 1920,
      inputDecodedPcmByteLength: 4480,
      outputDecodedPcmByteLength: 3840,
      inputDurationMs: 140,
      outputDurationMs: 240,
    },
    turns: [
      {
        id: "twilio-call",
        fixtureId: "synthetic-440hz-phone-tone",
        inputAudio: {
          sampleRateHz: 16000,
          encoding: "pcm_s16le",
          channels: 1,
          byteLength: 4480,
          wireByteLength: 1120,
          decodedPcmByteLength: 4480,
          frameCount: 7,
          durationMs: 140,
        },
        assistantAudio: {
          sampleRateHz: 8000,
          encoding: "pcmu",
          channels: 1,
          byteLength: 1920,
          wireByteLength: 1920,
          decodedPcmByteLength: 3840,
          frameCount: 12,
          durationMs: 240,
        },
          latencyMs: {
            firstOutboundMediaAfterStart: 174,
            firstInboundMediaAfterStart: 17,
            lastInboundMediaAfterStart: 146,
            maxInboundMediaGap: 43,
            firstOutboundMediaAfterFirstInbound: 157,
            firstOutboundMediaAfterLastInbound: 28,
          },
      },
    ],
    qualityGate: { passed: true, failures: [] },
  };
}

function makeSmartPbxOpusManifest(args: {
  readonly outputDurationMs: number;
  readonly turnOutputDurationMs: number;
}): SmokeArtifactManifest {
  return {
    schemaVersion: 2,
    scenario: "smartpbx_media_stream_emulated_phone_agent",
    generatedAt: "2026-05-28T00:00:00.000Z",
    transport: "smartpbx_media_stream_websocket",
    fixtureProvider: "synthetic-pcm-tone",
    run: { runDir: "test/performance/runs/smartpbx-opus" },
    audio: {
      inputSampleRateHz: 16000,
      outputSampleRateHz: 48000,
      inputByteLength: 4480,
      outputByteLength: 1669,
      inputWireByteLength: 1016,
      outputWireByteLength: 1669,
      inputDecodedPcmByteLength: 4480,
      outputDecodedPcmByteLength: 23040,
      inputDurationMs: 140,
      outputDurationMs: args.outputDurationMs,
    },
    turns: [
      {
        id: "smartpbx-call",
        fixtureId: "synthetic-440hz-phone-tone",
        inputAudio: {
          sampleRateHz: 16000,
          encoding: "pcm_s16le",
          channels: 1,
          byteLength: 4480,
          wireByteLength: 1016,
          decodedPcmByteLength: 4480,
          frameCount: 7,
          durationMs: 140,
        },
        assistantAudio: {
          sampleRateHz: 48000,
          encoding: "opus",
          channels: 1,
          byteLength: 1669,
          wireByteLength: 1669,
          decodedPcmByteLength: 23040,
          frameCount: 12,
          durationMs: args.turnOutputDurationMs,
        },
          latencyMs: {
            firstOutboundMediaAfterStart: 173,
            firstInboundMediaAfterStart: 15,
            lastInboundMediaAfterStart: 144,
            maxInboundMediaGap: 43,
            firstOutboundMediaAfterFirstInbound: 158,
            firstOutboundMediaAfterLastInbound: 29,
          },
      },
    ],
    qualityGate: { passed: true, failures: [] },
  };
}
