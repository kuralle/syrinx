// SPDX-License-Identifier: MIT
//
// Standalone WebSocket client for the media-lane inter-frame-gap harness.
// Connects to a server the supervisor started; does not call provider APIs itself.
//
// Run (supervisor):
//   1. Start delay server URL via SYRINX_MEDIA_LANE_DELAY_URL (harness can start one)
//   2. Start websocket server with createUniversitySupportSlowToolSession
//   3. npx tsx scripts/run-media-lane-harness.ts --url ws://127.0.0.1:PORT/ws --repeats 3

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket, { type RawData } from "ws";
import { Decoder as OpusDecoder } from "@evan/opus";

import { decodeSyrinxAudioEnvelope, hasSyrinxAudioEnvelope } from "@kuralle-syrinx/core";
import { pcm16BytesToSamples, pcm16SamplesToBytes, resamplePcm16 } from "@kuralle-syrinx/core/audio";

import { readPcm16Mono16kWav } from "../src/run-one-turn.js";
import { SLOW_TOOL_NAME } from "../src/university-support-slow-tool-agent.js";
import {
  aggregateMeasuredRepeats,
  aggregateRepeats,
  assessRunValidity,
  computeLargestGapMs,
  computeLargestGapMsInWindow,
  deriveQueuedMs,
  evaluateDurationShortfall,
  evaluateGapThreshold,
  formatMeasuredNumber,
  FRAME_CADENCE_MS,
  sumCarriedDurationMs,
  type AudioFrameSample,
  type Measured,
  type RunValidity,
  type TurnLatencyWirePayload,
} from "./media-lane-gap-metrics.js";
import { startMediaLaneDelayServer, type MediaLaneDelayServer } from "./media-lane-delay-server.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 16000;
const OPUS_WIRE_SAMPLE_RATE = 48000;
const FRAME_SAMPLES = 320;
const TRAILING_SILENCE_MS = 1400;
const POST_TTS_DRAIN_MS = 500;
const TURN_TIMEOUT_MS = 120_000;
/** How often the client reports playout position when --emit-playout-progress is set. */
const PLAYOUT_REPORT_EVERY_FRAMES = 5;

const SHORT_FIXTURE = {
  id: "review-late-add",
  path: join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav"),
  text:
    "Hi, I'm Maya Chen, student ID S one zero zero four two. I need to know whether I can still add Biology one oh one after the deadline, and what form I should submit.",
} as const;

interface SessionStartCapture {
  readonly tsMs?: number;
  readonly [key: string]: unknown;
}

interface HarnessRunCapture {
  readonly runIndex: number;
  readonly turnId: string;
  readonly arrivalTimestampsMs: number[];
  readonly frames: AudioFrameSample[];
  readonly framesReceived: number;
  readonly audioDurationMs: number;
  readonly largestGapMs: Measured<number>;
  readonly wholeUtteranceGapMs: Measured<number>;
  readonly queuedMs: Measured<number>;
  readonly runValidity: RunValidity;
  readonly toolWindow: {
    readonly startMs: number | null;
    readonly endMs: number | null;
    readonly slowToolName: string;
  };
  readonly durationShortfall: ReturnType<typeof evaluateDurationShortfall>;
  readonly turnLatency: TurnLatencyWirePayload | null;
  readonly turnLatencyReceived: boolean;
  readonly sessionStart: SessionStartCapture | null;
  readonly toolCalls: readonly string[];
}

interface HarnessArtifact {
  readonly scenario: "media_lane_harness";
  readonly generatedAt: string;
  readonly wsUrl: string;
  readonly delayServerUrl: string;
  readonly delayMs: number;
  readonly repeats: number;
  readonly fixtureId: string;
  readonly runs: readonly HarnessRunCapture[];
  readonly aggregate: {
    readonly largestGapMs: ReturnType<typeof aggregateMeasuredRepeats>;
    readonly audioDurationMs: ReturnType<typeof aggregateRepeats>;
    readonly framesReceived: ReturnType<typeof aggregateRepeats>;
    readonly queuedMs: ReturnType<typeof aggregateMeasuredRepeats>;
  };
  readonly thresholdVerdict: ReturnType<typeof evaluateGapThreshold>;
  readonly validRunCount: number;
  readonly invalidRunCount: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let delayServer: MediaLaneDelayServer | null = null;
  if (!args.delayServerUrl) {
    delayServer = await startMediaLaneDelayServer({ defaultDelayMs: args.delayMs });
    console.log(`delay server: ${delayServer.url}`);
  }

  const delayServerUrl = args.delayServerUrl ?? delayServer!.url;
  const wsUrl = args.wsUrl;
  if (!wsUrl) throw new Error("--url is required (websocket URL of the server under test)");

  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `media-lane-harness-${runId}`);
  await mkdir(runDir, { recursive: true });

  const runs: HarnessRunCapture[] = [];
  for (let index = 0; index < args.repeats; index += 1) {
    console.log(`starting repeat ${String(index + 1)}/${String(args.repeats)}`);
    const capture = await runSingleHarnessTurn(wsUrl, index, args.expectedAudioDurationMs, args.emitPlayoutProgress);
    runs.push(capture);
    const validityLabel = capture.runValidity.state === "valid"
      ? "valid"
      : `INVALID: ${capture.runValidity.reasons.join("; ")}`;
    console.log(
      `repeat ${String(index + 1)}: frames=${String(capture.framesReceived)} ` +
        `audioMs=${String(capture.audioDurationMs)} ` +
        `wholeUtteranceGapMs=${formatMeasuredNumber(capture.wholeUtteranceGapMs)} ` +
        `toolWindowGapMs=${formatMeasuredNumber(capture.largestGapMs)} ` +
        `queuedMs=${formatMeasuredNumber(capture.queuedMs)} ` +
        `runValidity=${validityLabel}`,
    );
    if (index + 1 < args.repeats) await sleep(500);
  }

  const audioDurationSeries = runs.map((run) => run.audioDurationMs);
  const framesReceivedSeries = runs.map((run) => run.framesReceived);
  // The threshold is judged on the whole-utterance gap, because the tool-window figure is
  // unmeasurable on a first-turn tool call — see the note where wholeUtteranceGapMs is
  // computed. Falls back to the tool-window figure when a fixture does put audio in it.
  const validGapValues = runs.flatMap((run) => {
    if (run.runValidity.state !== "valid") return [];
    const gap = run.wholeUtteranceGapMs.state === "measured" ? run.wholeUtteranceGapMs : run.largestGapMs;
    if (gap.state !== "measured") return [];
    return [gap.value];
  });
  const thresholdVerdict = validGapValues.length > 0
    ? evaluateGapThreshold({ state: "measured", value: Math.max(...validGapValues) })
    : evaluateGapThreshold({
        state: "unavailable",
        reason: "no valid runs with sufficient frame samples",
      });
  const validRunCount = runs.filter((run) => run.runValidity.state === "valid").length;
  const invalidRunCount = runs.length - validRunCount;

  const artifact: HarnessArtifact = {
    scenario: "media_lane_harness",
    generatedAt: new Date().toISOString(),
    wsUrl,
    delayServerUrl,
    delayMs: args.delayMs,
    repeats: args.repeats,
    fixtureId: SHORT_FIXTURE.id,
    runs,
    aggregate: {
      largestGapMs: aggregateMeasuredRepeats(runs.map((run) => ({
        measured: run.largestGapMs,
        runValidity: run.runValidity,
      }))),
      audioDurationMs: aggregateRepeats(audioDurationSeries),
      framesReceived: aggregateRepeats(framesReceivedSeries),
      queuedMs: aggregateMeasuredRepeats(runs.map((run) => ({
        measured: run.queuedMs,
        runValidity: run.runValidity,
      }))),
    },
    thresholdVerdict,
    validRunCount,
    invalidRunCount,
  };

  const artifactPath = join(runDir, "artifact.json");
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log("");
  console.log(`artifact: ${relative(PKG_ROOT, artifactPath)}`);
  console.log(
    `run validity: valid=${String(validRunCount)} invalid=${String(invalidRunCount)}`,
  );
  console.log(
    `threshold verdict: largestGapMs=${formatMeasuredNumber(thresholdVerdict.largestGapMs)} ` +
      `threshold=${String(thresholdVerdict.thresholdMs)} verdict=${thresholdVerdict.verdict}`,
  );
  if (args.repeats > 1) {
    console.log(
      `largestGapMs median=${String(artifact.aggregate.largestGapMs.median)} ` +
        `max=${String(artifact.aggregate.largestGapMs.max)}`,
    );
  } else {
    console.log(`largestGapMs=${String(artifact.aggregate.largestGapMs.value)}`);
  }

  if (delayServer) await delayServer.close();
}

interface ParsedArgs {
  readonly wsUrl: string | undefined;
  readonly repeats: number;
  readonly delayMs: number;
  readonly delayServerUrl: string | undefined;
  readonly expectedAudioDurationMs: number;
  readonly emitPlayoutProgress: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let wsUrl = process.env["SYRINX_MEDIA_LANE_WS_URL"]?.trim();
  let repeats = Number.parseInt(process.env["SYRINX_MEDIA_LANE_REPEATS"] ?? "1", 10);
  let delayMs = Number.parseInt(process.env["SYRINX_MEDIA_LANE_DELAY_MS"] ?? "2000", 10);
  let delayServerUrl = process.env["SYRINX_MEDIA_LANE_DELAY_URL"]?.trim();
  let expectedAudioDurationMs = Number.parseInt(process.env["SYRINX_MEDIA_LANE_EXPECTED_AUDIO_MS"] ?? "0", 10);
  let emitPlayoutProgress = process.env["SYRINX_MEDIA_LANE_EMIT_PLAYOUT"] === "1";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") wsUrl = argv[index + 1]?.trim();
    if (arg === "--repeats") repeats = Number.parseInt(argv[index + 1] ?? "1", 10);
    if (arg === "--delay-ms") delayMs = Number.parseInt(argv[index + 1] ?? "2000", 10);
    if (arg === "--delay-url") delayServerUrl = argv[index + 1]?.trim();
    if (arg === "--emit-playout-progress") emitPlayoutProgress = true;
    if (arg === "--expected-audio-ms") {
      expectedAudioDurationMs = Number.parseInt(argv[index + 1] ?? "0", 10);
    }
  }

  if (!Number.isFinite(repeats) || repeats < 1) repeats = 1;
  if (!Number.isFinite(delayMs) || delayMs < 0) delayMs = 2000;

  return { wsUrl, repeats, delayMs, delayServerUrl, expectedAudioDurationMs, emitPlayoutProgress };
}

async function runSingleHarnessTurn(
  wsUrl: string,
  runIndex: number,
  expectedAudioDurationMs: number,
  emitPlayoutProgress = false,
): Promise<HarnessRunCapture> {
  const socket = await openSocket(wsUrl);
  const turnId = `media-lane-${String(runIndex + 1).padStart(2, "0")}`;
  const opusDecoder = new OpusDecoder({ channels: 1, sample_rate: OPUS_WIRE_SAMPLE_RATE });

  const frames: AudioFrameSample[] = [];
  const toolCalls: string[] = [];
  let slowToolCallId: string | null = null;
  let toolWindowStartMs: number | null = null;
  let toolWindowEndMs: number | null = null;
  let turnLatency: TurnLatencyWirePayload | null = null;
  let turnLatencyReceived = false;
  let sessionStart: SessionStartCapture | null = null;
  let assistantEncoding: "pcm_s16le" | "opus" | "unknown" = "unknown";
  let ttsEndedAtMs = 0;
  let agentEndedAtMs = 0;
  let sttFinalAtMs = 0;
  let firstAudioAtMs = 0;
  let playedOutMs = 0;

  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (process.env["SYRINX_MEDIA_LANE_TRACE"] === "1") {
      if (isBinary) {
        console.log(`  trace: BINARY ${String(rawBytes(data).byteLength)}B`);
      } else {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        const type = String(parsed["type"]);
        console.log(type === "error" ? `  trace: ERROR ${data.toString()}` : `  trace: ${type}`);
      }
    }
    if (isBinary) {
      // Count EVERY outbound audio frame. The server paces binary audio on its own
      // 20ms cadence, decoupled from the tts_chunk JSON markers — gating on those
      // admits roughly one frame per marker and computes the inter-frame gap from a
      // decimated series, which is the one measurement this harness exists to make.
      // One turn per connection, so every audio frame on this socket is this turn's.
      const arrivedAtMs = Date.now();
      const wire = rawBytes(data);
      const durationMs = accumulateFrameDuration(wire, assistantEncoding, opusDecoder);
      frames.push({ arrivedAtMs, durationMs });
      if (firstAudioAtMs === 0) firstAudioAtMs = arrivedAtMs;
      // On the EDGE transport the client is the playout clock: the server streams
      // envelopes and the browser schedules them, so `tts.playout_progress` exists on
      // the bus only because a client reports its position (edge.ts maps the
      // `playout_progress` message onto a Route.Main packet). The Node WS host paces
      // server-side and emits it itself, so this is opt-in — sending it there would
      // add packets the real Node client never sends and change the baseline.
      if (emitPlayoutProgress) {
        playedOutMs += durationMs;
        if (frames.length % PLAYOUT_REPORT_EVERY_FRAMES === 0) {
          socket.send(JSON.stringify({
            type: "playout_progress",
            contextId: turnId,
            playedOutMs,
            complete: false,
          }));
        }
      }
      return;
    }

    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    if (typeof msg["turnId"] === "string" && msg["turnId"] !== turnId && msg["type"] !== "ready" && msg["type"] !== "session_start") {
      return;
    }

    if (msg["type"] === "ready") {
      // The downlink encoding is declared at ready, before any tts_chunk arrives.
      const audio = msg["audio"];
      if (audio !== null && typeof audio === "object") {
        const encoding = (audio as Record<string, unknown>)["encoding"];
        if (typeof encoding === "string") {
          assistantEncoding = encoding === "opus" ? "opus" : "pcm_s16le";
        }
      }
      return;
    }

    if (msg["type"] === "session_start") {
      sessionStart = msg as SessionStartCapture;
      return;
    }
    if (msg["type"] === "turn_latency") {
      turnLatencyReceived = true;
      turnLatency = msg as TurnLatencyWirePayload;
      return;
    }
    if (msg["type"] === "agent_tool_call") {
      const name = String(msg["name"] ?? "");
      toolCalls.push(name);
      if (name === SLOW_TOOL_NAME && toolWindowStartMs === null) {
        slowToolCallId = String(msg["id"] ?? "");
        toolWindowStartMs = Date.now();
      }
      return;
    }
    if (msg["type"] === "agent_tool_result") {
      const resultId = String(msg["id"] ?? "");
      if (slowToolCallId !== null && resultId === slowToolCallId) {
        toolWindowEndMs = Date.now();
      }
      return;
    }
    if (msg["type"] === "stt_output") {
      sttFinalAtMs = Date.now();
      return;
    }
    if (msg["type"] === "agent_end" && msg["turnId"] === turnId) {
      agentEndedAtMs = Date.now();
      return;
    }
    if (msg["type"] === "tts_chunk") {
      if (typeof msg["encoding"] === "string") {
        assistantEncoding = msg["encoding"] === "opus" ? "opus" : "pcm_s16le";
      }
      return;
    }
    if (msg["type"] === "tts_end" && msg["turnId"] === turnId) {
      ttsEndedAtMs = Date.now();
    }
  };

  socket.on("message", onMessage);
  try {
    const samples = readPcm16Mono16kWav(SHORT_FIXTURE.path);
    await sendPcmFrames(socket, samples, turnId);
    await sendSilence(socket, turnId, TRAILING_SILENCE_MS);
    await waitForTurnComplete({
      sttFinalAtMs: () => sttFinalAtMs,
      agentEndedAtMs: () => agentEndedAtMs,
      firstAudioAtMs: () => firstAudioAtMs,
      ttsEndedAtMs: () => ttsEndedAtMs,
      turnId,
    });
    await sleep(POST_TTS_DRAIN_MS);
  } finally {
    socket.off("message", onMessage);
    socket.close();
  }

  const arrivalTimestampsMs = frames.map((frame) => frame.arrivedAtMs);
  const windowStartMs = toolWindowStartMs ?? 0;
  const windowEndMs = toolWindowEndMs ?? 0;
  const largestGapMs = toolWindowStartMs !== null && toolWindowEndMs !== null
    ? computeLargestGapMsInWindow(arrivalTimestampsMs, windowStartMs, windowEndMs)
    : computeLargestGapMsInWindow(arrivalTimestampsMs, firstAudioAtMs || 0, ttsEndedAtMs || Date.now());
  // Gap across the WHOLE utterance, independent of where the tool landed. Measured
  // 2026-08-09: on a first-turn tool call the tool window contains zero audio frames,
  // because the cascade is sequential and nothing is speaking while the tool blocks —
  // so a tool-window-only figure is unmeasurable there however healthy the lane is.
  // A parked drain loop stalls the paced stream wherever it happens, so this window
  // still discriminates while depending on nothing about tool/speech ordering.
  const wholeUtteranceGapMs = computeLargestGapMs(arrivalTimestampsMs);
  const queuedMs = deriveQueuedMs(turnLatencyReceived, turnLatency);
  // queuedMs being unavailable does NOT invalidate a gap measurement. The before-arm
  // runs a server that predates turn_latency on the wire, so it can never report
  // queuedMs — treating that as a broken run would condemn every before-run by
  // construction and leave nothing to compare the after-run against.
  const runValidity = assessRunValidity(
    { state: "measured", value: 0 },
    wholeUtteranceGapMs.state === "measured" ? wholeUtteranceGapMs : largestGapMs,
  );

  const audioDurationMs = sumCarriedDurationMs(frames);
  const durationShortfall = expectedAudioDurationMs > 0
    ? evaluateDurationShortfall(frames, expectedAudioDurationMs)
    : evaluateDurationShortfall(frames, audioDurationMs);

  return {
    runIndex,
    turnId,
    arrivalTimestampsMs,
    frames,
    framesReceived: frames.length,
    audioDurationMs,
    largestGapMs,
    wholeUtteranceGapMs,
    queuedMs,
    runValidity,
    toolWindow: {
      startMs: toolWindowStartMs,
      endMs: toolWindowEndMs,
      slowToolName: SLOW_TOOL_NAME,
    },
    durationShortfall,
    turnLatency,
    turnLatencyReceived,
    sessionStart,
    toolCalls,
  };
}

function accumulateFrameDuration(
  wire: Uint8Array,
  encoding: "pcm_s16le" | "opus" | "unknown",
  opusDecoder: OpusDecoder,
): number {
  if (encoding === "opus") {
    const pcm48 = pcm16BytesToSamples(opusDecoder.decode(wire));
    const pcm16 = resamplePcm16(pcm48, OPUS_WIRE_SAMPLE_RATE, OUTPUT_SAMPLE_RATE);
    return Math.round((pcm16.length / OUTPUT_SAMPLE_RATE) * 1000);
  }
  if (encoding === "pcm_s16le") {
    return Math.round((wire.byteLength / 2 / OUTPUT_SAMPLE_RATE) * 1000);
  }
  return FRAME_CADENCE_MS;
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  await waitForJson(socket, (msg) => msg.type === "ready", 10_000);
  return socket;
}

async function sendPcmFrames(socket: WebSocket, samples: Int16Array, contextId: string): Promise<void> {
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
  for (let index = 0; index < frames; index += 1) {
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

async function waitForTurnComplete(checks: {
  readonly sttFinalAtMs: () => number;
  readonly agentEndedAtMs: () => number;
  readonly firstAudioAtMs: () => number;
  readonly ttsEndedAtMs: () => number;
  readonly turnId: string;
}): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < TURN_TIMEOUT_MS) {
    if (
      checks.sttFinalAtMs() > 0 &&
      checks.agentEndedAtMs() > 0 &&
      checks.firstAudioAtMs() > 0 &&
      checks.ttsEndedAtMs() > 0
    ) {
      return;
    }
    await sleep(100);
  }
  // Name the signals still missing. "turn timeout" alone cannot tell a server that
  // never spoke from one whose completion message carried a different turnId, and
  // those two have opposite fixes.
  const missing = [
    checks.sttFinalAtMs() > 0 ? null : "stt_output",
    checks.agentEndedAtMs() > 0 ? null : `agent_end(turnId=${checks.turnId})`,
    checks.firstAudioAtMs() > 0 ? null : "binary audio",
    checks.ttsEndedAtMs() > 0 ? null : `tts_end(turnId=${checks.turnId})`,
  ].filter((name): name is string => name !== null);
  throw new Error(`turn timeout: ${checks.turnId} — never received: ${missing.join(", ")}`);
}

async function waitForJson(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("websocket JSON wait timeout"));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function rawBytes(data: RawData): Uint8Array {
  let bytes: Uint8Array;
  if (Buffer.isBuffer(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (Array.isArray(data)) bytes = Uint8Array.from(Buffer.concat(data));
  else throw new Error("Unsupported binary websocket payload");
  if (hasSyrinxAudioEnvelope(bytes)) return decodeSyrinxAudioEnvelope(bytes).audio;
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
