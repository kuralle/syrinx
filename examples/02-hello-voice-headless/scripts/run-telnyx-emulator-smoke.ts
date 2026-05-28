// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket, { type RawData } from "ws";
import { Route, VoiceAgentSession, type UserAudioReceivedPacket } from "@asyncdot/voice";
import {
  createTelnyxMediaStreamServer,
  encodePcm16ToMuLaw,
  pcm16SamplesToBytes,
} from "@asyncdot/voice-server-websocket";

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
const TELNYX_SAMPLE_RATE_HZ = 8000;
const STREAM_ID = "telnyx-emulated-stream";
const CALL_CONTROL_ID = "telnyx-emulated-call-control";
const CONTEXT_ID = `telnyx-${CALL_CONTROL_ID}`;
const ASSISTANT_OUTPUT_DURATION_SECONDS = 0.24;
const INPUT_DURATION_SECONDS = 0.14;
const OUTBOUND_FRAME_DURATION_MS = 20;
const EXPECTED_INBOUND_FRAMES = Math.round((INPUT_DURATION_SECONDS * 1000) / OUTBOUND_FRAME_DURATION_MS);
const EXPECTED_OUTBOUND_FRAMES = Math.round((ASSISTANT_OUTPUT_DURATION_SECONDS * 1000) / OUTBOUND_FRAME_DURATION_MS);
const EXPECTED_OUTBOUND_BYTES = EXPECTED_OUTBOUND_FRAMES * TELNYX_SAMPLE_RATE_HZ * OUTBOUND_FRAME_DURATION_MS / 1000;
type NetworkProfile = "clean" | "jittery" | "bursty";

interface InboundSendStats {
  readonly wireBytes: number;
  readonly firstMediaAfterStartMs: number;
  readonly lastMediaAfterStartMs: number;
  readonly maxMediaGapMs: number;
}

interface SmokeResult {
  inboundFrames: number;
  inboundWireBytes: number;
  inboundBytes: number;
  firstInboundMediaAfterStartMs: number;
  lastInboundMediaAfterStartMs: number;
  maxInboundMediaGapMs: number;
  outboundFrames: number;
  outboundBytes: number;
  outboundMarks: number;
  outboundEndMarks: number;
  firstOutboundMediaAfterMs: number;
  firstOutboundMediaAfterFirstInboundMs: number;
  firstOutboundMediaAfterLastInboundMs: number;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `telnyx-emulator-${runId}`);
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
  let outboundMarks = 0;
  let outboundEndMarks = 0;
  let firstOutboundMediaAfterMs = -1;
  let responded = false;

  const server = await createTelnyxMediaStreamServer({
    port: 0,
    inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    outputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    bidirectionalCodec: "PCMU",
    createSession: () => {
      const session = new VoiceAgentSession({ plugins: {} });
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

  const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/telnyx`);
  const onOutboundMessage = (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString());
    if (message.event === "media") {
      outboundFrames += 1;
      outboundBytes += Buffer.from(message.media.payload, "base64").byteLength;
      if (firstOutboundMediaAfterMs < 0) firstOutboundMediaAfterMs = Date.now() - startedAt;
    } else if (message.event === "mark") {
      outboundMarks += 1;
      if (message.mark?.name?.endsWith(":end")) outboundEndMarks += 1;
    }
  };
  try {
    socket.on("message", onOutboundMessage);
    await waitForOpen(socket);
    socket.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
    socket.send(JSON.stringify({
      event: "start",
      stream_id: STREAM_ID,
      start: {
        stream_id: STREAM_ID,
        call_control_id: CALL_CONTROL_ID,
        media_format: {
          encoding: "PCMU",
          sample_rate: TELNYX_SAMPLE_RATE_HZ,
          channels: 1,
        },
      },
    }));

    const outboundMedia = waitForJson(socket, (message) => message.event === "media", 3000);
    const outboundMark = waitForJson(socket, (message) => message.event === "mark", 3000);
    inboundSendStats = await sendEmulatedPhoneAudio(socket, startedAt);

    const firstMedia = await outboundMedia;
    const firstMark = await outboundMark;
    const firstPayloadBytes = Buffer.from(firstMedia.media.payload, "base64").byteLength;
    if ("stream_id" in firstMedia) throw new Error("Outbound Telnyx media unexpectedly included stream_id");
    if (firstPayloadBytes !== 160) throw new Error(`Expected one 20 ms PCMU frame, got ${String(firstPayloadBytes)} bytes`);
    if (typeof firstMark.mark?.name !== "string" || firstMark.mark.name.length === 0) {
      throw new Error("Expected Telnyx playback mark name");
    }
    if ("stream_id" in firstMark) throw new Error("Outbound Telnyx mark unexpectedly included stream_id");
    const endMarkPromise = waitForJson(socket, (message) => message.event === "mark" && message.mark?.name?.endsWith(":end"), 3000);
    socket.send(JSON.stringify({
      event: "mark",
      stream_id: STREAM_ID,
      mark: {
        name: firstMark.mark.name,
      },
    }));
    const endMark = await endMarkPromise;
    socket.send(JSON.stringify({
      event: "mark",
      stream_id: STREAM_ID,
      mark: {
        name: endMark.mark.name,
      },
    }));

    socket.send(JSON.stringify({ event: "stop", stream_id: STREAM_ID }));
    const result: SmokeResult = {
      inboundFrames,
      inboundWireBytes: inboundSendStats.wireBytes,
      inboundBytes,
      firstInboundMediaAfterStartMs: inboundSendStats.firstMediaAfterStartMs,
      lastInboundMediaAfterStartMs: inboundSendStats.lastMediaAfterStartMs,
      maxInboundMediaGapMs: inboundSendStats.maxMediaGapMs,
      outboundFrames,
      outboundBytes,
      outboundMarks,
      outboundEndMarks,
      firstOutboundMediaAfterMs,
      firstOutboundMediaAfterFirstInboundMs: firstOutboundMediaAfterMs - inboundSendStats.firstMediaAfterStartMs,
      firstOutboundMediaAfterLastInboundMs: firstOutboundMediaAfterMs - inboundSendStats.lastMediaAfterStartMs,
    };
    const failures = evaluateResult(result);
    await writeSmokeArtifactManifest(manifestPath, buildSmokeManifest({
      generatedAt,
      runDir,
      failures,
      result,
    }));
    console.log(JSON.stringify({
      scenario: "telnyx_media_stream_emulated_phone_agent",
      transport: "telnyx_media_stream_websocket",
      contextId: CONTEXT_ID,
      qualityGate: {
        passed: failures.length === 0,
        failures,
      },
      artifacts: {
        runDir: relative(PKG_ROOT, runDir),
        manifestPath: relative(PKG_ROOT, manifestPath),
      },
      result,
    }, null, 2));
    if (failures.length > 0) throw new Error(`telnyx emulator smoke failed: ${failures.join("; ")}`);
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
    failures.push(`expected ${EXPECTED_INBOUND_FRAMES} inbound Telnyx media frames, got ${result.inboundFrames}`);
  }
  if (result.inboundBytes <= 0) failures.push("expected inbound engine PCM bytes");
  if (result.outboundFrames !== EXPECTED_OUTBOUND_FRAMES) {
    failures.push(`expected ${EXPECTED_OUTBOUND_FRAMES} outbound Telnyx media frames, got ${result.outboundFrames}`);
  }
  if (result.outboundBytes !== EXPECTED_OUTBOUND_BYTES) {
    failures.push(`expected ${EXPECTED_OUTBOUND_BYTES} outbound Telnyx media bytes, got ${result.outboundBytes}`);
  }
  if (result.outboundMarks !== 2) failures.push(`expected two outbound Telnyx marks, got ${result.outboundMarks}`);
  if (result.outboundEndMarks !== 1) failures.push(`expected one outbound Telnyx terminal mark, got ${result.outboundEndMarks}`);
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
    scenario: "telnyx_media_stream_emulated_phone_agent",
    generatedAt: args.generatedAt,
    transport: "telnyx_media_stream_websocket",
    fixtureProvider: "synthetic-pcm-tone",
    run: {
      runDir: relative(PKG_ROOT, args.runDir),
    },
    audio: {
      inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      outputSampleRateHz: TELNYX_SAMPLE_RATE_HZ,
      inputByteLength: args.result.inboundBytes,
      outputByteLength: args.result.outboundBytes,
      inputWireByteLength: args.result.inboundWireBytes,
      outputWireByteLength: args.result.outboundBytes,
      inputDecodedPcmByteLength: args.result.inboundBytes,
      outputDecodedPcmByteLength: args.result.outboundBytes * 2,
      inputDurationMs: pcm16DurationMs(args.result.inboundBytes, INPUT_SAMPLE_RATE_HZ),
      outputDurationMs: pcMuDurationMs(args.result.outboundBytes, TELNYX_SAMPLE_RATE_HZ),
    },
    turns: [
      {
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
          sampleRateHz: TELNYX_SAMPLE_RATE_HZ,
          encoding: "pcmu",
          channels: 1,
          byteLength: args.result.outboundBytes,
          wireByteLength: args.result.outboundBytes,
          decodedPcmByteLength: args.result.outboundBytes * 2,
          frameCount: args.result.outboundFrames,
          durationMs: pcMuDurationMs(args.result.outboundBytes, TELNYX_SAMPLE_RATE_HZ),
        },
        latencyMs: {
          firstOutboundMediaAfterStart: args.result.firstOutboundMediaAfterMs,
          firstInboundMediaAfterStart: args.result.firstInboundMediaAfterStartMs,
          lastInboundMediaAfterStart: args.result.lastInboundMediaAfterStartMs,
          maxInboundMediaGap: args.result.maxInboundMediaGapMs,
          firstOutboundMediaAfterFirstInbound: args.result.firstOutboundMediaAfterFirstInboundMs,
          firstOutboundMediaAfterLastInbound: args.result.firstOutboundMediaAfterLastInboundMs,
        },
      },
    ],
    qualityGate: {
      passed: args.failures.length === 0,
      failures: args.failures,
    },
  };
}

async function sendEmulatedPhoneAudio(socket: WebSocket, startedAt: number): Promise<InboundSendStats> {
  const interFrameDelaysMs = interFrameDelays(readNetworkProfile());
  const frameSamples = TELNYX_SAMPLE_RATE_HZ * 20 / 1000;
  const audio = generateTone(TELNYX_SAMPLE_RATE_HZ, 440, INPUT_DURATION_SECONDS);
  let wireBytes = 0;
  let firstMediaAfterStartMs = -1;
  let lastMediaAfterStartMs = -1;
  let previousMediaAfterStartMs = -1;
  let maxMediaGapMs = 0;
  for (let offset = 0, chunk = 1; offset < audio.length; offset += frameSamples, chunk += 1) {
    const frame = audio.subarray(offset, Math.min(audio.length, offset + frameSamples));
    const payload = Buffer.from(encodePcm16ToMuLaw(frame));
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
      stream_id: STREAM_ID,
      media: {
        track: "inbound",
        chunk: String(chunk),
        timestamp: String(chunk * 20),
        payload: payload.toString("base64"),
      },
    }));
    await sleep(interFrameDelaysMs[chunk - 1] ?? 20);
  }
  return { wireBytes, firstMediaAfterStartMs, lastMediaAfterStartMs, maxMediaGapMs };
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
  predicate: (message: any) => boolean,
  timeoutMs: number,
): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for Telnyx websocket message"));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
