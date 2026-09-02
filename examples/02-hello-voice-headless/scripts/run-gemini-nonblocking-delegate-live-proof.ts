// SPDX-License-Identifier: MIT
//
// Live proof for the "tool-call-while-talking" acceptance item: with the delegate tool
// declared NON_BLOCKING and RealtimeBridge configured `delegateBehavior: "NON_BLOCKING"`,
// the front model must keep talking while the reasoner "thinks", instead of going silent
// for the whole consult.
//
// Two arms, ONE driver, so the only variable is delegateBehavior (BLOCKING vs NON_BLOCKING):
//   before — delegateBehavior: "BLOCKING" (today's default). Expected: no assistant audio
//            between the tool_call and the terminal answer — the front holds the turn.
//   after  — delegateBehavior: "NON_BLOCKING", tool declared `behavior: "NON_BLOCKING"`.
//            Expected: assistant audio DURING the reasoner's artificial 6s "thinking gap",
//            and the terminal answer voiced shortly after it lands.
//
// A before arm that already keeps talking during the gap means the harness cannot detect
// the defect, and the after arm proves nothing — that is the failure mode this two-arm
// shape exists to catch (same rationale as run-gemini-goaway-live-proof.ts).
//
// Usage:
//   npx tsx scripts/run-gemini-nonblocking-delegate-live-proof.ts               # both arms
//   npx tsx scripts/run-gemini-nonblocking-delegate-live-proof.ts --arm after   # one arm
//   npx tsx scripts/run-gemini-nonblocking-delegate-live-proof.ts --arm before

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Route, VoiceAgentSession, type Reasoner, type TextToSpeechAudioPacket } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromGeminiLive } from "@kuralle-syrinx/realtime";
import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef } from "@kuralle-syrinx/realtime";

import { GEMINI_LIVE_MODEL } from "../src/gemini-live-smoke.js";
import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-cs-masters-deadline.wav");
const LOG_PATH = join(REPO_ROOT, "runs", "nonblocking-delegate-proof.log");

const DELEGATE_TOOL_NAME = "consult_knowledge";
const REASONER_DELAY_MS = 6_000;
const REASONER_ANSWER = "The registrar's office opens at nine in the morning.";
const FRAME_SAMPLES = 320; // 20ms @ 16kHz
const ARM_TIMEOUT_MS = 60_000;
const POST_ANSWER_GRACE_MS = 4_000;

type Arm = "before" | "after";

interface Mark {
  readonly atMs: number;
  readonly what: string;
}

interface ArmResult {
  readonly arm: Arm;
  readonly delegateBehavior: "BLOCKING" | "NON_BLOCKING";
  readonly toolCallAtMs: number | null;
  readonly terminalInjectAtMs: number | null;
  readonly audioDuringWait: boolean;
  readonly gapAfterAnswerMs: number | null;
  readonly sawTtsEnd: boolean;
  readonly assistantAudioFrameCount: number;
  readonly marks: readonly Mark[];
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sliceFramePcm(samples: Readonly<Int16Array>, offset: number): Int16Array {
  const end = Math.min(offset + FRAME_SAMPLES, samples.length);
  const frame = new Int16Array(FRAME_SAMPLES);
  if (end > offset) frame.set(samples.subarray(offset, end));
  return frame;
}

function pcmToBytes(samples: Readonly<Int16Array>): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Tees adapter events AND `injectToolResult` calls — the latter is how this proof observes
 * the NON_BLOCKING ack vs. the terminal answer, neither of which is a `RealtimeEvent`.
 */
function teeRealtimeAdapter(
  inner: RealtimeAdapter,
  onEvent: (ev: RealtimeEvent) => void,
  onInject: (
    toolId: string,
    text: string,
    opts?: { scheduling?: "SILENT" | "WHEN_IDLE" | "INTERRUPT"; willContinue?: boolean },
  ) => void,
): RealtimeAdapter {
  return {
    caps: inner.caps,
    open: (signal) => inner.open(signal),
    sendAudio: (pcm16) => inner.sendAudio(pcm16),
    cancelResponse: (audioEndMs) => inner.cancelResponse(audioEndMs),
    injectToolResult: (toolId, text, opts) => {
      onInject(toolId, text, opts);
      inner.injectToolResult(toolId, text, opts);
    },
    close: () => inner.close(),
    events: teeEvents(inner.events, onEvent),
  };
}

async function* teeEvents(
  source: AsyncIterable<RealtimeEvent>,
  onEvent: (ev: RealtimeEvent) => void,
): AsyncGenerator<RealtimeEvent> {
  for await (const ev of source) {
    onEvent(ev);
    yield ev;
  }
}

async function runArm(apiKey: string, arm: Arm): Promise<ArmResult> {
  const delegateBehavior: "BLOCKING" | "NON_BLOCKING" = arm === "after" ? "NON_BLOCKING" : "BLOCKING";
  const t0 = Date.now();
  const at = (): number => Date.now() - t0;
  const marks: Mark[] = [];
  const mark = (what: string): void => {
    marks.push({ atMs: at(), what });
    console.log(`  [${arm}] [${(at() / 1000).toFixed(1)}s] ${what}`);
  };

  let toolCallAtMs: number | null = null;
  let terminalInjectAtMs: number | null = null;
  const assistantAudioAtMs: number[] = [];

  const tool: RealtimeToolDef = {
    name: DELEGATE_TOOL_NAME,
    description: "Look up an authoritative answer before responding to any factual question.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    ...(delegateBehavior === "NON_BLOCKING" ? { behavior: "NON_BLOCKING" as const } : {}),
  };

  const baseAdapter = fromGeminiLive({
    apiKey,
    model: GEMINI_LIVE_MODEL,
    systemInstruction:
      "For any question that needs a factual lookup, ALWAYS call consult_knowledge with the " +
      "user's question as `query` before answering. Keep talking naturally while you wait for it.",
    tools: [tool],
  });

  const adapter = teeRealtimeAdapter(
    baseAdapter,
    (ev) => {
      if (ev.type === "tool_call" && toolCallAtMs === null) {
        toolCallAtMs = at();
        mark(`adapter.tool_call ${ev.toolName}`);
      } else if (ev.type === "error") {
        mark(`adapter.error ${ev.cause.message.slice(0, 140)}`);
      }
    },
    (_toolId, _text, opts) => {
      if (opts?.willContinue) {
        mark(`adapter.injectToolResult ack (${opts.scheduling ?? "none"} + willContinue)`);
        return;
      }
      terminalInjectAtMs = at();
      mark(`adapter.injectToolResult terminal (scheduling=${opts?.scheduling ?? "none"})`);
    },
  );

  const reasoner: Reasoner = {
    stream: () => (async function* () {
      await sleep(REASONER_DELAY_MS);
      yield { type: "finish", reason: "stop", text: REASONER_ANSWER };
    })(),
  };

  const bridge = new RealtimeBridge(adapter, reasoner, DELEGATE_TOOL_NAME, { delegateBehavior });
  const session = new VoiceAgentSession({ plugins: { realtime: {} }, endpointingOwner: "timer" });
  session.registerPlugin("realtime", bridge);

  let sawTtsEnd = false;
  session.bus.on<TextToSpeechAudioPacket>("tts.audio", () => { assistantAudioAtMs.push(at()); });
  session.bus.on("tts.end", () => {
    sawTtsEnd = true;
    mark("bus.tts.end");
  });

  await session.start();
  mark(`session.start (delegateBehavior=${delegateBehavior}, tool.behavior=${tool.behavior ?? "BLOCKING"})`);

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  const transportContextId = crypto.randomUUID();
  let offset = 0;
  while (offset < pcm.length) {
    const frame = sliceFramePcm(pcm, offset);
    session.bus.push(Route.Media, {
      kind: "user.audio_received",
      contextId: transportContextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(frame),
    });
    offset += FRAME_SAMPLES;
    await sleep(20);
  }
  // Trailing silence so server VAD/endpointing closes the user's turn.
  for (let pad = 0; pad < 100; pad += 1) {
    session.bus.push(Route.Media, {
      kind: "user.audio_received",
      contextId: transportContextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)),
    });
    await sleep(20);
  }
  mark("user.audio.done");

  const deadline = Date.now() + ARM_TIMEOUT_MS;
  while (Date.now() < deadline && (terminalInjectAtMs === null || !sawTtsEnd)) {
    await sleep(200);
  }
  // Grace period to capture the assistant audio that follows the terminal answer.
  await sleep(POST_ANSWER_GRACE_MS);

  await session.close().catch(() => undefined);
  await adapter.close().catch(() => undefined);

  const audioDuringWait =
    toolCallAtMs !== null &&
    terminalInjectAtMs !== null &&
    assistantAudioAtMs.some((ms) => ms > toolCallAtMs! && ms < terminalInjectAtMs!);

  const firstAudioAfterAnswerAtMs =
    terminalInjectAtMs !== null ? assistantAudioAtMs.find((ms) => ms >= terminalInjectAtMs!) ?? null : null;
  const gapAfterAnswerMs =
    firstAudioAfterAnswerAtMs !== null && terminalInjectAtMs !== null
      ? firstAudioAfterAnswerAtMs - terminalInjectAtMs
      : null;

  return {
    arm,
    delegateBehavior,
    toolCallAtMs,
    terminalInjectAtMs,
    audioDuringWait,
    gapAfterAnswerMs,
    sawTtsEnd,
    assistantAudioFrameCount: assistantAudioAtMs.length,
    marks,
  };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["GEMINI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");

  const armFlag = arg("arm", "both");
  if (armFlag !== "before" && armFlag !== "after" && armFlag !== "both") {
    throw new Error("--arm must be before|after|both");
  }
  const arms: readonly Arm[] = armFlag === "both" ? ["before", "after"] : [armFlag];

  const results: ArmResult[] = [];
  for (const arm of arms) {
    console.log(`\n=== ARM: ${arm} ===`);
    results.push(await runArm(apiKey, arm));
  }

  const before = results.find((r) => r.arm === "before");
  const after = results.find((r) => r.arm === "after");

  // PASS requires: the after arm's audio kept flowing during the wait, the before arm's did
  // not, and the after arm's terminal answer was actually voiced. An arm that was not run
  // does not fail its half of the check (single-arm invocations only prove that arm).
  const afterKeptTalking = after ? after.audioDuringWait : true;
  const beforeStayedSilent = before ? !before.audioDuringWait : true;
  const terminalVoiced = after ? after.sawTtsEnd && after.terminalInjectAtMs !== null : true;
  const pass = afterKeptTalking && beforeStayedSilent && terminalVoiced;

  const summary = {
    proof: "gemini NON_BLOCKING delegate dispatch (tool-call-while-talking)",
    verdict: pass ? "PASS" : "FAIL",
    reasonerDelayMs: REASONER_DELAY_MS,
    checks: { afterKeptTalking, beforeStayedSilent, terminalVoiced },
    results,
  };

  console.log(`\n=== NON_BLOCKING DELEGATE: ${summary.verdict} ===`);
  console.log(JSON.stringify(summary, null, 2));

  await mkdir(dirname(LOG_PATH), { recursive: true });
  await writeFile(LOG_PATH, JSON.stringify(summary, null, 2));
  console.log(`\nlog written to ${LOG_PATH}`);

  if (!pass) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
