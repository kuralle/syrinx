// SPDX-License-Identifier: MIT
//
// Edge metrics probe: drive ONE real turn through a deployed `/ws` endpoint and print
// the `turn_latency` and `metrics` frames the server sends back, verbatim. Exists so a
// wire-contract change (field names, anchors) can be read off a deployed Worker instead
// of inferred from unit tests.
//
// Usage: SYRINX_WS_URL=wss://host/ws npx tsx scripts/run-edge-metrics-probe.ts [--reps 1]
//
// Requires nothing locally beyond the fixture; the server needs its provider secrets.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(SCRIPT_DIR, "..", "test", "fixtures", "university-support-add-drop.wav");
const INPUT_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;
const TRAILING_SILENCE_MS = 1400;
const TURN_TIMEOUT_MS = 60_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const PLAYOUT_DELAY_MS = Number.parseInt(arg("playout-delay-ms", "1500"), 10);

function readPcm16Mono16kWav(path: string): Int16Array {
  const buf = readFileSync(path);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") return new Int16Array(buf.buffer, buf.byteOffset + offset + 8, size / 2);
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Capture {
  readonly sessionId: string;
  readyMs: number;
  turnLatency: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  firstTtsChunkMs: number;
  ttsEndMs: number;
  errors: string[];
}

async function oneTurn(baseUrl: string, rep: number): Promise<Capture> {
  const sessionId = `edge-metrics-probe-${Date.now()}-${rep}`;
  const contextId = `probe-turn-${rep}`;
  const cap: Capture = { sessionId, readyMs: -1, turnLatency: null, metrics: null, firstTtsChunkMs: 0, ttsEndMs: 0, errors: [] };
  const t0 = Date.now();
  const ws = new WebSocket(`${baseUrl}?sessionId=${encodeURIComponent(sessionId)}`);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for ready")), 20_000);
    ws.on("message", (raw: unknown, isBinary: boolean) => {
      if (isBinary) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
      if (msg["type"] === "ready") { cap.readyMs = Date.now() - t0; clearTimeout(timer); resolve(); }
      if (msg["type"] === "turn_latency") cap.turnLatency = msg;
      if (msg["type"] === "metrics") cap.metrics = msg;
      if (msg["type"] === "tts_chunk" && cap.firstTtsChunkMs === 0) cap.firstTtsChunkMs = Date.now() - t0;
      if (msg["type"] === "tts_end") cap.ttsEndMs = Date.now() - t0;
      if (msg["type"] === "error") cap.errors.push(JSON.stringify(msg));
      // The edge client is the playout clock: report playout so the server can finalize
      // the turn's metrics the way a browser would (edge.ts maps this onto the bus).
      if (msg["type"] === "tts_end" && PLAYOUT_DELAY_MS >= 0) {
        // A browser finishes playing well after synthesis ends; report completion after a
        // realistic delay (or never, with --playout-delay-ms -1, to exercise the tts.end floor).
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "playout_progress", contextId: msg["turnId"] ?? contextId, playedOutMs: PLAYOUT_DELAY_MS, complete: true }));
        }, PLAYOUT_DELAY_MS);
      }
    });
    ws.on("error", (e: Error) => reject(e));
  });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  await ready;

  const samples = readPcm16Mono16kWav(FIXTURE);
  const send = (frame: Int16Array): void => {
    ws.send(JSON.stringify({
      type: "audio",
      contextId,
      sampleRateHz: INPUT_SAMPLE_RATE,
      audio: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString("base64"),
    }));
  };
  for (let off = 0; off < samples.length; off += FRAME_SAMPLES) {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(off, Math.min(off + FRAME_SAMPLES, samples.length)));
    send(frame);
    await sleep(20);
  }
  for (let i = 0; i < Math.ceil(TRAILING_SILENCE_MS / 20); i += 1) { send(new Int16Array(FRAME_SAMPLES)); await sleep(20); }

  const started = Date.now();
  while (Date.now() - started < TURN_TIMEOUT_MS) {
    if (cap.errors.length > 0) break;
    if (cap.metrics !== null && cap.turnLatency !== null) break;
    await sleep(100);
  }
  await sleep(500);
  ws.close();
  return cap;
}

async function main(): Promise<void> {
  const baseUrl = (process.env["SYRINX_WS_URL"] ?? "").trim();
  if (!baseUrl) throw new Error("SYRINX_WS_URL is required (e.g. wss://host/ws)");
  const reps = Number.parseInt(arg("reps", "1"), 10);
  const captures: Capture[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const cap = await oneTurn(baseUrl, rep);
    captures.push(cap);
    console.log(JSON.stringify({ rep, readyMs: cap.readyMs, firstTtsChunkMs: cap.firstTtsChunkMs, ttsEndMs: cap.ttsEndMs, errors: cap.errors, turn_latency: cap.turnLatency, metrics: cap.metrics }, null, 2));
  }
  // The edge host emits `metrics` only; `turn_latency` is forwarded by the Node host alone
  // (server-websocket/src/index.ts) — a known gap, reported here as a count, not a failure.
  const missing = captures.filter((c) => c.metrics === null).length;
  const turnLatencyMissing = captures.filter((c) => c.turnLatency === null).length;
  const legacy = captures.some((c) => c.metrics && ["sttMs", "llmTTFTMs", "ttsTTFBMs", "e2eMs"].some((k) => k in c.metrics!));
  const unified = captures.every((c) => c.metrics && "ttfaMs" in c.metrics && "anchor" in c.metrics);
  const pass = missing === 0 && !legacy && unified;
  console.log(JSON.stringify({ verdict: pass ? "PASS" : "FAIL", reps, metricsMissing: missing, turnLatencyMissing, legacyNamesSeen: legacy, unifiedNames: unified }));
  process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
