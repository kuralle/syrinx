// SPDX-License-Identifier: MIT

import { buildSessionRecord } from "@kuralle-syrinx/browser-client/record";
import { describe, expect, it } from "vitest";

import { hasSessionDetails, sessionInfoRows } from "./session-info";

/**
 * The `ready` message the Node host actually sends — server-websocket/src/index.ts:359.
 * Opus downlink, both input codecs offered, envelope conditional on config.
 */
const NODE_READY = {
  type: "ready",
  sessionId: "node-session-1",
  turnId: "ctx-1",
  resumed: false,
  resumeWindowMs: 60_000,
  maxSessionDurationMs: 3_600_000,
  audio: {
    inputSampleRateHz: 16_000,
    outputSampleRateHz: 48_000,
    encoding: "opus",
    supportedInputCodecs: ["pcm_s16le", "opus"],
    channels: 1,
    targetFrameDurationMs: 20,
    binaryEnvelope: "syrinx.audio.v1",
    rawBinaryInput: false,
    maxInboundMessageBytes: 1_048_576,
  },
} as const;

/**
 * The `ready` message the Workers/Durable Object host actually sends —
 * server-websocket/src/edge.ts:337. PCM downlink, one input codec, envelope always on.
 */
const WORKERS_READY = {
  type: "ready",
  sessionId: "cf-session-1",
  turnId: "ctx-1",
  resumed: false,
  resumeWindowMs: 30_000,
  maxSessionDurationMs: 600_000,
  audio: {
    inputSampleRateHz: 16_000,
    outputSampleRateHz: 24_000,
    encoding: "pcm_s16le",
    supportedInputCodecs: ["pcm_s16le"],
    channels: 1,
    binaryEnvelope: "syrinx.audio.v1",
    rawBinaryInput: true,
    maxInboundMessageBytes: 1_048_576,
  },
} as const;

const configFrom = (ready: unknown, wsUrl: string) =>
  buildSessionRecord([{ message: ready as never, atMs: 0 }], { wsUrl }).config;

const valueOf = (rows: readonly { key: string; value?: string }[], key: string) =>
  rows.find((row) => row.key === key)?.value;

describe("sessionInfoRows", () => {
  it("matches the Node host's ready message field for field", () => {
    const rows = sessionInfoRows(configFrom(NODE_READY, "ws://127.0.0.1:4173/ws"));
    expect(valueOf(rows, "sessionId")).toBe("node-session-1");
    expect(valueOf(rows, "target")).toBe("ws://127.0.0.1:4173/ws");
    expect(valueOf(rows, "inputSampleRateHz")).toBe("16000 Hz");
    expect(valueOf(rows, "outputSampleRateHz")).toBe("48000 Hz");
    expect(valueOf(rows, "encoding")).toBe("opus");
    expect(valueOf(rows, "binaryEnvelope")).toBe("syrinx.audio.v1");
    expect(valueOf(rows, "rawBinaryInput")).toBe("no");
    expect(valueOf(rows, "resumeWindowMs")).toBe("60.00s");
  });

  it("matches the Cloudflare host's ready message field for field", () => {
    // The runtime-drift canary: the same rows, the real other runtime's values.
    // Every field the Node host states, this one states too — with different values.
    const rows = sessionInfoRows(configFrom(WORKERS_READY, "wss://worker.test/ws"));
    expect(valueOf(rows, "sessionId")).toBe("cf-session-1");
    expect(valueOf(rows, "target")).toBe("wss://worker.test/ws");
    expect(valueOf(rows, "inputSampleRateHz")).toBe("16000 Hz");
    expect(valueOf(rows, "outputSampleRateHz")).toBe("24000 Hz");
    expect(valueOf(rows, "encoding")).toBe("pcm_s16le");
    expect(valueOf(rows, "binaryEnvelope")).toBe("syrinx.audio.v1");
    expect(valueOf(rows, "rawBinaryInput")).toBe("yes");
    expect(valueOf(rows, "resumeWindowMs")).toBe("30.00s");
  });

  it("states the same set of fields for both runtimes", () => {
    const node = sessionInfoRows(configFrom(NODE_READY, "ws://a/ws"));
    const workers = sessionInfoRows(configFrom(WORKERS_READY, "wss://b/ws"));
    const stated = (rows: readonly { key: string; value?: string }[]) =>
      rows.filter((row) => row.value !== undefined).map((row) => row.key);
    // A field one runtime answers and the other does not is a bug, not a tier —
    // this is the assertion that would catch it.
    expect(stated(node)).toEqual(stated(workers));
  });

  it("keeps `false` distinct from not stated", () => {
    // Collapsing these would hide exactly the drift this panel exists to catch.
    const stated = sessionInfoRows({ rawBinaryInput: false });
    const absent = sessionInfoRows({});
    expect(valueOf(stated, "rawBinaryInput")).toBe("no");
    expect(valueOf(absent, "rawBinaryInput")).toBeUndefined();
  });

  it("leaves a field the server never sent absent, rather than zero", () => {
    const rows = sessionInfoRows({ wsUrl: "ws://a/ws" });
    expect(valueOf(rows, "inputSampleRateHz")).toBeUndefined();
    expect(valueOf(rows, "outputSampleRateHz")).toBeUndefined();
    expect(valueOf(rows, "resumeWindowMs")).toBeUndefined();
    expect(valueOf(rows, "endpointingOwner")).toBeUndefined();
    // Nothing anywhere reads as a measured value.
    expect(rows.map((row) => row.value).filter((v) => v !== undefined)).toEqual(["ws://a/ws"]);
  });

  it("glosses the encoding without hiding its real name", () => {
    const rows = sessionInfoRows({ encoding: "pcm_s16le" });
    const row = rows.find((r) => r.key === "encoding");
    expect(row?.value).toBe("pcm_s16le");
    expect(row?.note).toMatch(/16-bit signed PCM/i);
  });
});

describe("hasSessionDetails", () => {
  it("is false before the server has said anything", () => {
    expect(hasSessionDetails({})).toBe(false);
    // A target the studio chose is not the server describing the session.
    expect(hasSessionDetails({ wsUrl: "ws://a/ws" })).toBe(false);
  });

  it("is true once ready has landed", () => {
    expect(hasSessionDetails(configFrom(NODE_READY, "ws://a/ws"))).toBe(true);
    expect(hasSessionDetails(configFrom(WORKERS_READY, "wss://b/ws"))).toBe(true);
  });
});
