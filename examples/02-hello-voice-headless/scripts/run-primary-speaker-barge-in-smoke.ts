// SPDX-License-Identifier: MIT
//
// VE-02 live smoke: enroll primary speaker, play assistant TTS, inject bystander
// speech during playout — assistant must not be falsely interrupted.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  Route,
  VoiceAgentSession,
  type InterruptTtsPacket,
  type UserAudioReceivedPacket,
  type VadAudioPacket,
  type VadSpeechActivityPacket,
  type VadSpeechStartedPacket,
} from "@asyncdot/voice";
import {
  BYSTANDER_SPEAKER_TONE_HZ,
  synthesizeTonePcm16,
} from "@asyncdot/voice";
import { SileroVADPlugin } from "@asyncdot/voice-vad-silero";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");
const ENROLL_WAV = join(
  PKG_ROOT,
  "test",
  "fixtures",
  "gemini-university-support",
  "01-late-add.wav",
);

export interface PrimarySpeakerBargeInSmokeResult {
  readonly ok: boolean;
  readonly interrupts: number;
  readonly metrics: readonly string[];
  readonly qualityGate: { readonly passed: boolean; readonly failures: readonly string[] };
  readonly runDir?: string;
}

export function evaluatePrimarySpeakerBargeInSmoke(
  result: Omit<PrimarySpeakerBargeInSmokeResult, "ok" | "qualityGate">,
): string[] {
  const failures: string[] = [];
  if (result.interrupts > 0) {
    failures.push(`expected 0 false barge-in interrupts, got ${String(result.interrupts)}`);
  }
  if (!result.metrics.includes("interrupt.suppressed_non_primary")) {
    failures.push("expected interrupt.suppressed_non_primary metric");
  }
  return failures;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `primary-speaker-barge-in-${runId}`);
  await mkdir(runDir, { recursive: true });

  const metrics: string[] = [];
  const interrupts: InterruptTtsPacket[] = [];
  const session = new VoiceAgentSession({
    plugins: { vad: { threshold: 0.45 } },
    minInterruptionMs: 280,
    primarySpeakerBargeInEnabled: true,
  });
  const vad = new SileroVADPlugin();
  await session.registerPlugin("vad", vad);
  await session.start();

  session.bus.on("metric.conversation", (pkt) => {
    metrics.push((pkt as unknown as { name: string }).name);
  });
  session.bus.on("interrupt.tts", (pkt) => {
    interrupts.push(pkt as InterruptTtsPacket);
  });

  const enrollPcm = await readFile(ENROLL_WAV);
  const frameBytes = 640;
  for (let offset = 0; offset < enrollPcm.byteLength; offset += frameBytes) {
    const slice = enrollPcm.subarray(offset, Math.min(offset + frameBytes, enrollPcm.byteLength));
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: "enroll",
      timestampMs: Date.now(),
      audio: slice,
    } satisfies UserAudioReceivedPacket);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  session.bus.push(Route.Main, {
    kind: "vad.speech_ended",
    contextId: "enroll",
    timestampMs: Date.now(),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  session.bus.push(Route.Main, {
    kind: "tts.audio",
    contextId: "assistant",
    timestampMs: Date.now(),
    audio: synthesizeTonePcm16({ frequencyHz: 520, durationMs: 1200, amplitude: 0.25 }),
    sampleRateHz: 16000,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const bystander = synthesizeTonePcm16({
    frequencyHz: BYSTANDER_SPEAKER_TONE_HZ,
    durationMs: 32,
    amplitude: 0.5,
  });
  for (let i = 0; i < 12; i += 1) {
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: "bystander",
      timestampMs: Date.now(),
      audio: bystander,
    } satisfies UserAudioReceivedPacket);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const t0 = Date.now();
  session.bus.push(Route.Main, {
    kind: "vad.speech_started",
    contextId: "bystander",
    timestampMs: t0,
    confidence: 0.95,
  } satisfies VadSpeechStartedPacket);
  for (let i = 0; i < 10; i += 1) {
    session.bus.push(Route.Main, {
      kind: "vad.audio",
      contextId: "bystander",
      timestampMs: t0 + 20 + i * 30,
      audio: bystander,
    } satisfies VadAudioPacket);
  }
  session.bus.push(Route.Main, {
    kind: "vad.speech_activity",
    contextId: "bystander",
    timestampMs: t0 + 320,
    isAsync: true,
  } satisfies VadSpeechActivityPacket);
  await new Promise((resolve) => setTimeout(resolve, 100));

  await session.close();

  const failures = evaluatePrimarySpeakerBargeInSmoke({
    interrupts: interrupts.length,
    metrics,
  });
  const result: PrimarySpeakerBargeInSmokeResult = {
    ok: failures.length === 0,
    interrupts: interrupts.length,
    metrics,
    qualityGate: { passed: failures.length === 0, failures },
    runDir: relative(PKG_ROOT, runDir),
  };

  const baselinePath = join(runDir, "baseline.json");
  await writeFile(baselinePath, `${JSON.stringify({ generatedAt, ...result }, null, 2)}\n`, "utf8");

  if (!result.ok) {
    throw new Error(`primary-speaker barge-in smoke failed: ${failures.join("; ")}`);
  }
  console.log(`primary-speaker barge-in smoke passed → ${baselinePath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
