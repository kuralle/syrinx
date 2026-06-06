// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const HOSTED_WS_URL = "wss://syrinx-voice-server-workers.mithushancj.workers.dev/ws";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(
  APP_ROOT,
  "..",
  "..",
  "examples",
  "02-hello-voice-headless",
  "test",
  "fixtures",
  "university-support-add-drop.wav",
);

const INPUT_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;
const TRAILING_SILENCE_MS = 1400;
const TIMEOUT_MS = 120_000;

interface TurnCapture {
  transcript: string;
  agentReply: string;
  agentEnded: boolean;
  error?: string;
}

async function main(): Promise<void> {
  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  const turnId = `hosted-test-${Date.now().toString(36)}`;
  const capture: TurnCapture = {
    transcript: "",
    agentReply: "",
    agentEnded: false,
  };

  const socket = await openSocket(HOSTED_WS_URL);
  const dispose = captureMessages(socket, turnId, capture);

  try {
    await streamPcm(socket, pcm, turnId);
    await sendSilence(socket, turnId, TRAILING_SILENCE_MS);
    await waitForTurn(capture);
  } finally {
    dispose();
    socket.close();
  }

  if (!capture.transcript.trim()) {
    console.error("hosted-test failed: missing stt_output transcript");
    process.exit(1);
  }
  if (!capture.agentReply.trim() || !capture.agentEnded) {
    console.error("hosted-test failed: missing agent_chunk/agent_end assistant text");
    process.exit(1);
  }

  console.log("hosted-test transcript:", capture.transcript);
  console.log("hosted-test assistant:", capture.agentReply);
}

function readPcm16Mono16kWav(path: string): Int16Array {
  const buffer = readFileSync(path);
  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`fixture is not a WAV file: ${path}`);
  }
  const sampleRate = buffer.readUInt32LE(24);
  const numChannels = buffer.readUInt16LE(22);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (sampleRate !== INPUT_SAMPLE_RATE || numChannels !== 1 || bitsPerSample !== 16) {
    throw new Error(`fixture must be mono 16-bit PCM at ${String(INPUT_SAMPLE_RATE)} Hz`);
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      const byteLength = Math.min(chunkSize, buffer.length - dataStart);
      const samples = new Int16Array(byteLength / 2);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = buffer.readInt16LE(dataStart + i * 2);
      }
      return samples;
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  throw new Error(`WAV data chunk not found: ${path}`);
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  // Attach the `ready` listener SYNCHRONOUSLY at construction — the server sends `ready`
  // immediately after upgrade, so awaiting `open` first and attaching afterward races it away.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ready timeout")), 15_000);
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return; // ws delivers TEXT frames as Buffer — gate on isBinary, not typeof string
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type === "ready") {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
    socket.once("error", (err) => {
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
  return socket;
}

function captureMessages(socket: WebSocket, turnId: string, capture: TurnCapture): () => void {
  const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    if (isBinary) return; // ws delivers TEXT frames as Buffer — gate on isBinary, not typeof string
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    if (typeof message.turnId === "string" && message.turnId !== turnId) return;
    if (message.type === "stt_output") {
      capture.transcript = String(message.transcript ?? "");
      return;
    }
    if (message.type === "agent_chunk") {
      capture.agentReply += String(message.text ?? "");
      return;
    }
    if (message.type === "agent_end") {
      capture.agentEnded = true;
      return;
    }
    if (message.type === "error") {
      capture.error = `${String(message.component ?? "error")}: ${String(message.message ?? "")}`;
    }
  };
  socket.on("message", onMessage);
  return () => socket.off("message", onMessage);
}

async function streamPcm(socket: WebSocket, samples: Int16Array, contextId: string): Promise<void> {
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    const end = Math.min(offset + FRAME_SAMPLES, samples.length);
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(offset, end));
    sendAudioFrame(socket, frame, contextId);
    await sleep(20);
  }
}

async function sendSilence(socket: WebSocket, contextId: string, durationMs: number): Promise<void> {
  const frames = Math.ceil(durationMs / 20);
  for (let i = 0; i < frames; i += 1) {
    sendAudioFrame(socket, new Int16Array(FRAME_SAMPLES), contextId);
    await sleep(20);
  }
}

function sendAudioFrame(socket: WebSocket, frame: Int16Array, contextId: string): void {
  socket.send(JSON.stringify({
    type: "audio",
    contextId,
    sampleRateHz: INPUT_SAMPLE_RATE,
    audio: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString("base64"),
  }));
}

async function waitForTurn(capture: TurnCapture): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    if (capture.error) throw new Error(capture.error);
    if (capture.transcript.trim() && capture.agentReply.trim() && capture.agentEnded) return;
    await sleep(100);
  }
  throw new Error(
    `turn timeout; transcript=${String(Boolean(capture.transcript.trim()))} ` +
      `agent=${String(Boolean(capture.agentReply.trim()))} agent_end=${String(capture.agentEnded)}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
