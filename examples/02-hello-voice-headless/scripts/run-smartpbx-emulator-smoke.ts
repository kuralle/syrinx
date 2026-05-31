// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket, { type RawData } from "ws";
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from "@evan/opus";
import { Route, VoiceAgentSession, type UserAudioReceivedPacket } from "@asyncdot/voice";
import { createSmartPbxMediaStreamServer } from "@asyncdot/voice-server-websocket";
import { encodePcm16ToMuLaw, pcm16BytesToSamples, pcm16SamplesToBytes } from "@asyncdot/voice/audio";

import {
  pcMuDurationMs,
  pcm16DurationMs,
  writeSmokeArtifactManifest,
  type SmokeArtifactManifest,
} from "./smoke-artifact-manifest.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(SCRIPT_DIR, "..", "test", "performance", "runs");
const INPUT_SAMPLE_RATE_HZ = 16000;
const CALL_ID = "smartpbx-emulated-call";
const ACCOUNT_ID = "smartpbx-emulated-account";
const CONTEXT_ID = `smartpbx-${CALL_ID}`;
const ASSISTANT_OUTPUT_DURATION_SECONDS = 0.24;
const INPUT_DURATION_SECONDS = 0.14;
const OUTBOUND_FRAME_DURATION_MS = 20;
const EXPECTED_INBOUND_FRAMES = Math.round((INPUT_DURATION_SECONDS * 1000) / OUTBOUND_FRAME_DURATION_MS);
const EXPECTED_OUTBOUND_FRAMES = Math.round((ASSISTANT_OUTPUT_DURATION_SECONDS * 1000) / OUTBOUND_FRAME_DURATION_MS);
type SmartPbxSmokeCodec = "g711_ulaw" | "pcm16" | "opus";
type NetworkProfile = "clean" | "jittery" | "bursty";

interface InboundSendStats {
  readonly wireBytes: number;
  readonly firstMediaAfterStartMs: number;
  readonly lastMediaAfterStartMs: number;
  readonly maxMediaGapMs: number;
}

interface SmokeResult {
  codec: SmartPbxSmokeCodec;
  wireSampleRateHz: number;
  inboundFrames: number;
  inboundWireBytes: number;
  inboundBytes: number;
  firstInboundMediaAfterStartMs: number;
  lastInboundMediaAfterStartMs: number;
  maxInboundMediaGapMs: number;
  outboundFrames: number;
  outboundBytes: number;
  outboundDecodedBytes: number;
  localPlayoutDrains: number;
  firstOutboundMediaAfterMs: number;
  firstOutboundMediaAfterFirstInboundMs: number;
  firstOutboundMediaAfterLastInboundMs: number;
}

interface JsonMessage {
  readonly event?: string;
  readonly media?: { readonly payload?: string };
  readonly [key: string]: unknown;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const codec = readCodec();
  const wireSampleRateHz = codec === "opus" ? 48000 : codec === "pcm16" ? 24000 : 8000;
  const runDir = join(RUNS_DIR, `smartpbx-emulator-${codec}-${runId}`);
  const manifestPath = join(runDir, "manifest.json");
  await mkdir(runDir, { recursive: true });

  let inboundFrames = 0;
  let inboundSendStats: InboundSendStats = {
    wireBytes: 0,
    firstMediaAfterStartMs: -1,
    lastMediaAfterStartMs: -1,
    maxMediaGapMs: 0,
  };
  let inboundBytes = 0;
  let outboundFrames = 0;
  let outboundBytes = 0;
  let outboundDecodedBytes = 0;
  let localPlayoutDrains = 0;
  let firstOutboundMediaAfterMs = -1;
  let responded = false;
  const inboundOpusEncoder = codec === "opus" ? new OpusEncoder({ channels: 1, sample_rate: 48000, application: "voip" }) : null;
  const outboundOpusDecoder = codec === "opus" ? new OpusDecoder({ channels: 1, sample_rate: 48000 }) : null;
  const server = await createSmartPbxMediaStreamServer({
    port: 0,
    inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    outputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    createSession: () => {
      const session = new VoiceAgentSession({ plugins: {} });
      session.bus.on("metric.conversation", (pkt) => {
        const metric = pkt as unknown as { contextId: string; name: string };
        if (metric.contextId === CONTEXT_ID && metric.name === "smartpbx.playout_drained") localPlayoutDrains += 1;
      });
      session.bus.on("user.audio_received", (pkt) => {
        const audio = pkt as UserAudioReceivedPacket;
        inboundFrames += 1;
        inboundBytes += audio.audio.byteLength;
        if (responded) return;
        if (inboundFrames < EXPECTED_INBOUND_FRAMES) return;
        responded = true;
        setTimeout(() => {
          const timestampMs = Date.now();
          session.bus.push(Route.Main, {
            kind: "tts.audio",
            contextId: audio.contextId,
            timestampMs,
            audio: pcm16SamplesToBytes(generateTone(INPUT_SAMPLE_RATE_HZ, 260, ASSISTANT_OUTPUT_DURATION_SECONDS)),
            sampleRateHz: 16000,
          });
          session.bus.push(Route.Main, {
            kind: "tts.end",
            contextId: audio.contextId,
            timestampMs: timestampMs + 1,
          });
        }, 25);
      });
      return session;
    },
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP websocket address");
  const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/media-stream`);
  const waitForOutboundDrain = createOutboundDrainWaiter();
  const onOutboundMessage = (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString());
    if (message.event !== "media") return;
    if (message.callId !== CALL_ID || message.accountId !== ACCOUNT_ID) {
      throw new Error("Outbound SmartPBX media is missing call/account identity");
    }
    outboundFrames += 1;
    const payload = Buffer.from(message.media.payload, "base64");
    outboundBytes += payload.byteLength;
    outboundDecodedBytes += decodedWireByteLength(payload, codec, outboundOpusDecoder);
    if (firstOutboundMediaAfterMs < 0) firstOutboundMediaAfterMs = Date.now() - startedAt;
    waitForOutboundDrain.record(outboundFrames);
  };

  try {
    socket.on("message", onOutboundMessage);
    await waitForOpen(socket);
    socket.send(JSON.stringify({
      event: "start",
      start: {
        callId: CALL_ID,
        otherLegCallId: "smartpbx-emulated-peer",
        callerIdNumber: "+94770000000",
        calleeIdNumber: "+94771111111",
        accountId: ACCOUNT_ID,
        mediaFormat: {
          encoding: codec,
          sampleRate: wireSampleRateHz,
        },
      },
    }));
    const outboundMedia = waitForJson(socket, (message) => message.event === "media", 3000);
    inboundSendStats = await sendEmulatedPhoneAudio(socket, codec, wireSampleRateHz, inboundOpusEncoder, startedAt);
    const firstMedia = await outboundMedia;
    const firstPayload = firstMedia.media?.payload;
    if (typeof firstPayload !== "string") throw new Error("Expected SmartPBX outbound media payload");
    const firstPayloadBytes = Buffer.from(firstPayload, "base64").byteLength;
    if (firstMedia.callId !== CALL_ID || firstMedia.accountId !== ACCOUNT_ID) {
      throw new Error("Outbound SmartPBX media is missing call/account identity");
    }
    if (firstPayloadBytes <= 0) throw new Error("Expected non-empty first SmartPBX outbound media payload");
    await waitForOutboundDrain.wait(3000);
    await waitForCondition(() => localPlayoutDrains > 0, 3000, "Timed out waiting for SmartPBX local playout drain");
    socket.send(JSON.stringify({ event: "hangup", hangup: { callId: CALL_ID, reason: "normal" } }));

    const result: SmokeResult = {
      codec,
      wireSampleRateHz,
      inboundFrames,
      inboundWireBytes: inboundSendStats.wireBytes,
      inboundBytes,
      firstInboundMediaAfterStartMs: inboundSendStats.firstMediaAfterStartMs,
      lastInboundMediaAfterStartMs: inboundSendStats.lastMediaAfterStartMs,
      maxInboundMediaGapMs: inboundSendStats.maxMediaGapMs,
      outboundFrames,
      outboundBytes,
      outboundDecodedBytes,
      localPlayoutDrains,
      firstOutboundMediaAfterMs,
      firstOutboundMediaAfterFirstInboundMs: firstOutboundMediaAfterMs - inboundSendStats.firstMediaAfterStartMs,
      firstOutboundMediaAfterLastInboundMs: firstOutboundMediaAfterMs - inboundSendStats.lastMediaAfterStartMs,
    };
    const failures = evaluateResult(result);
    await writeSmokeArtifactManifest(manifestPath, buildSmokeManifest({ generatedAt, runDir, failures, result }));
    console.log(JSON.stringify({
      scenario: "smartpbx_media_stream_emulated_phone_agent",
      transport: "smartpbx_media_stream_websocket",
      contextId: CONTEXT_ID,
      qualityGate: { passed: failures.length === 0, failures },
      artifacts: {
        runDir: relative(PKG_ROOT, runDir),
        manifestPath: relative(PKG_ROOT, manifestPath),
      },
      result,
    }, null, 2));
    if (failures.length > 0) throw new Error(`SmartPBX emulator smoke failed: ${failures.join("; ")}`);
  } finally {
    socket.off("message", onOutboundMessage);
    socket.close();
    await server.close();
  }
}

function evaluateResult(result: SmokeResult): string[] {
  const failures: string[] = [];
  if (result.inboundFrames <= 0) failures.push("expected inbound media frames");
  if (result.inboundFrames !== EXPECTED_INBOUND_FRAMES) {
    failures.push(`expected ${EXPECTED_INBOUND_FRAMES} inbound SmartPBX media frames, got ${result.inboundFrames}`);
  }
  if (result.inboundBytes <= 0) failures.push("expected inbound engine PCM bytes");
  if (result.outboundFrames !== EXPECTED_OUTBOUND_FRAMES) {
    failures.push(`expected ${EXPECTED_OUTBOUND_FRAMES} outbound SmartPBX media frames, got ${result.outboundFrames}`);
  }
  if (result.codec === "g711_ulaw") {
    const expectedOutboundBytes = EXPECTED_OUTBOUND_FRAMES * result.wireSampleRateHz * OUTBOUND_FRAME_DURATION_MS / 1000;
    if (result.outboundBytes !== expectedOutboundBytes) {
      failures.push(`expected ${expectedOutboundBytes} outbound SmartPBX media bytes, got ${result.outboundBytes}`);
    }
  } else if (result.outboundDecodedBytes <= 0) {
    failures.push("expected decodable outbound SmartPBX media bytes");
  }
  if (result.localPlayoutDrains !== 1) failures.push(`expected one SmartPBX local playout drain, got ${result.localPlayoutDrains}`);
  if (result.firstOutboundMediaAfterMs < 0) failures.push("first outbound media timing was negative");
  if (result.firstInboundMediaAfterStartMs < 0) failures.push("first inbound media timing was negative");
  if (result.lastInboundMediaAfterStartMs < result.firstInboundMediaAfterStartMs) failures.push("last inbound media preceded first inbound media");
  if (result.firstOutboundMediaAfterFirstInboundMs < 0) failures.push("first outbound media preceded first inbound media");
  if (result.firstOutboundMediaAfterLastInboundMs < 0) failures.push("first outbound media preceded last inbound media");
  return failures;
}

function buildSmokeManifest(args: {
  readonly generatedAt: string;
  readonly runDir: string;
  readonly failures: readonly string[];
  readonly result: SmokeResult;
}): SmokeArtifactManifest {
  return {
    schemaVersion: 2,
    scenario: "smartpbx_media_stream_emulated_phone_agent",
    generatedAt: args.generatedAt,
    transport: "smartpbx_media_stream_websocket",
    fixtureProvider: "synthetic-pcm-tone",
    run: { runDir: relative(PKG_ROOT, args.runDir) },
    audio: {
      inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      outputSampleRateHz: args.result.wireSampleRateHz,
      inputByteLength: args.result.inboundBytes,
      outputByteLength: args.result.outboundBytes,
      inputWireByteLength: args.result.inboundWireBytes,
      outputWireByteLength: args.result.outboundBytes,
      inputDecodedPcmByteLength: args.result.inboundBytes,
      outputDecodedPcmByteLength: args.result.outboundDecodedBytes,
      inputDurationMs: pcm16DurationMs(args.result.inboundBytes, INPUT_SAMPLE_RATE_HZ),
      outputDurationMs: smartPbxOutputDurationMs(args.result),
    },
    turns: [{
      id: CONTEXT_ID,
      fixtureId: "synthetic-440hz-phone-tone",
      inputAudio: {
        sampleRateHz: INPUT_SAMPLE_RATE_HZ,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: args.result.inboundBytes,
        wireByteLength: args.result.inboundWireBytes,
        decodedPcmByteLength: args.result.inboundBytes,
        frameCount: args.result.inboundFrames,
        durationMs: pcm16DurationMs(args.result.inboundBytes, INPUT_SAMPLE_RATE_HZ),
      },
      assistantAudio: {
        sampleRateHz: args.result.wireSampleRateHz,
        encoding: smartPbxManifestEncoding(args.result.codec),
        channels: 1,
        byteLength: args.result.outboundBytes,
        wireByteLength: args.result.outboundBytes,
        decodedPcmByteLength: args.result.outboundDecodedBytes,
        frameCount: args.result.outboundFrames,
        durationMs: smartPbxOutputDurationMs(args.result),
      },
      latencyMs: {
        firstOutboundMediaAfterStart: args.result.firstOutboundMediaAfterMs,
        firstInboundMediaAfterStart: args.result.firstInboundMediaAfterStartMs,
        lastInboundMediaAfterStart: args.result.lastInboundMediaAfterStartMs,
        maxInboundMediaGap: args.result.maxInboundMediaGapMs,
        firstOutboundMediaAfterFirstInbound: args.result.firstOutboundMediaAfterFirstInboundMs,
        firstOutboundMediaAfterLastInbound: args.result.firstOutboundMediaAfterLastInboundMs,
      },
    }],
    qualityGate: { passed: args.failures.length === 0, failures: args.failures },
  };
}

async function sendEmulatedPhoneAudio(
  socket: WebSocket,
  codec: SmartPbxSmokeCodec,
  wireSampleRateHz: number,
  opusEncoder: OpusEncoder | null,
  startedAt: number,
): Promise<InboundSendStats> {
  const interFrameDelaysMs = interFrameDelays(readNetworkProfile());
  const frameSamples = wireSampleRateHz * 20 / 1000;
  const audio = generateTone(wireSampleRateHz, 440, INPUT_DURATION_SECONDS);
  let wireBytes = 0;
  let firstMediaAfterStartMs = -1;
  let lastMediaAfterStartMs = -1;
  let previousMediaAfterStartMs = -1;
  let maxMediaGapMs = 0;
  for (let offset = 0, chunk = 1; offset < audio.length; offset += frameSamples, chunk += 1) {
    const frame = audio.subarray(offset, Math.min(audio.length, offset + frameSamples));
    const payload = encodeWireFrame(frame, codec, opusEncoder);
    wireBytes += payload.byteLength;
    const sentAfterStartMs = Date.now() - startedAt;
    if (firstMediaAfterStartMs < 0) firstMediaAfterStartMs = sentAfterStartMs;
    if (previousMediaAfterStartMs >= 0) {
      maxMediaGapMs = Math.max(maxMediaGapMs, sentAfterStartMs - previousMediaAfterStartMs);
    }
    previousMediaAfterStartMs = sentAfterStartMs;
    lastMediaAfterStartMs = sentAfterStartMs;
    socket.send(JSON.stringify({
      event: "media",
      media: { payload: Buffer.from(payload).toString("base64") },
    }));
    await sleep(interFrameDelaysMs[chunk - 1] ?? 20);
  }
  return { wireBytes, firstMediaAfterStartMs, lastMediaAfterStartMs, maxMediaGapMs };
}

function encodeWireFrame(frame: Int16Array, codec: SmartPbxSmokeCodec, opusEncoder: OpusEncoder | null): Uint8Array {
  if (codec === "g711_ulaw") return encodePcm16ToMuLaw(frame);
  if (codec === "pcm16") return pcm16SamplesToBytes(frame);
  if (!opusEncoder) throw new Error("Opus encoder is required for SmartPBX opus smoke");
  return opusEncoder.encode(pcm16SamplesToBytes(frame));
}

function decodedWireByteLength(payload: Uint8Array, codec: SmartPbxSmokeCodec, opusDecoder: OpusDecoder | null): number {
  if (codec === "g711_ulaw") return payload.byteLength * 2;
  if (codec === "pcm16") return payload.byteLength;
  if (!opusDecoder) throw new Error("Opus decoder is required for SmartPBX opus smoke");
  return pcm16BytesToSamples(opusDecoder.decode(payload)).byteLength;
}

function smartPbxOutputDurationMs(result: SmokeResult): number {
  if (result.codec === "g711_ulaw") return pcMuDurationMs(result.outboundBytes, result.wireSampleRateHz);
  if (result.codec === "pcm16") return pcm16DurationMs(result.outboundBytes, result.wireSampleRateHz);
  return pcm16DurationMs(result.outboundDecodedBytes, result.wireSampleRateHz);
}

function readCodec(): SmartPbxSmokeCodec {
  const raw = process.env["SYRINX_SMARTPBX_EMULATOR_CODEC"]?.trim().toLowerCase();
  if (!raw || raw === "g711" || raw === "pcmu" || raw === "g711_ulaw") return "g711_ulaw";
  if (raw === "pcm16") return "pcm16";
  if (raw === "opus") return "opus";
  throw new Error(`Unsupported SYRINX_SMARTPBX_EMULATOR_CODEC: ${raw}`);
}

function readNetworkProfile(): NetworkProfile {
  const raw = process.env["SYRINX_EMULATED_NETWORK_PROFILE"]?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "clean") return "clean";
  if (raw === "jittery" || raw === "bursty") return raw;
  throw new Error(`Unsupported SYRINX_EMULATED_NETWORK_PROFILE: ${raw}`);
}

function interFrameDelays(profile: NetworkProfile): readonly number[] {
  if (profile === "jittery") return [35, 5, 45, 10, 30, 15, 20];
  if (profile === "bursty") return [0, 0, 60, 0, 0, 60, 20];
  return [20, 20, 20, 20, 20, 20, 20];
}

function smartPbxManifestEncoding(codec: SmartPbxSmokeCodec): "pcmu" | "pcm_s16le" | "opus" {
  if (codec === "g711_ulaw") return "pcmu";
  if (codec === "pcm16") return "pcm_s16le";
  return "opus";
}

function generateTone(sampleRateHz: number, frequencyHz: number, durationSeconds: number): Int16Array {
  const samples = new Int16Array(Math.round(sampleRateHz * durationSeconds));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRateHz) * 7000);
  }
  return samples;
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function waitForJson(
  socket: WebSocket,
  predicate: (message: JsonMessage) => boolean,
  timeoutMs: number,
): Promise<JsonMessage> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for SmartPBX websocket message"));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as JsonMessage;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function createOutboundDrainWaiter(): {
  readonly record: (frames: number) => void;
  readonly wait: (timeoutMs: number) => Promise<void>;
} {
  let resolveWait: (() => void) | null = null;
  let latestFrames = 0;
  return {
    record(frames) {
      latestFrames = frames;
      if (latestFrames >= EXPECTED_OUTBOUND_FRAMES) {
        resolveWait?.();
        resolveWait = null;
      }
    },
    async wait(timeoutMs) {
      if (latestFrames >= EXPECTED_OUTBOUND_FRAMES) return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolveWait = null;
          reject(new Error(`Timed out waiting for ${EXPECTED_OUTBOUND_FRAMES} SmartPBX outbound media frames`));
        }, timeoutMs);
        resolveWait = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    },
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
