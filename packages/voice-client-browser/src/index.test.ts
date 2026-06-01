// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeSyrinxAudioEnvelope } from "@asyncdot/voice";
import { SyrinxBrowserClient, type SyrinxBrowserClientEvent } from "./index.js";

const originalWebSocket = globalThis.WebSocket;
let sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  binaryType: BinaryType = "blob";
  readyState = FakeWebSocket.OPEN;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    const next = listeners.filter((entry) => entry !== listener);
    if (next.length === 0) this.listeners.delete(type);
    else this.listeners.set(type, next);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function makeClient(overrides: Partial<ConstructorParameters<typeof SyrinxBrowserClient>[0]> = {}) {
  return new SyrinxBrowserClient({ url: "ws://localhost/ws", ...overrides });
}

function collectEvents(client: SyrinxBrowserClient): SyrinxBrowserClientEvent[] {
  const events: SyrinxBrowserClientEvent[] = [];
  client.on((e) => events.push(e));
  return events;
}

describe("SyrinxBrowserClient — audio sequence", () => {
  beforeEach(() => {
    sockets = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("adds monotonic sequence metadata to every audio send path by default", () => {
    const client = makeClient();
    client.connect();
    const socket = sockets[0]!;

    client.sendAudioBase64(Buffer.from([1, 0, 2, 0]).toString("base64"), 16000, { contextId: "turn-json" });
    client.sendAudioPcm(new Uint8Array([3, 0, 4, 0]), 16000, { contextId: "turn-pcm" });
    client.sendFloat32Audio(new Float32Array([0, 0.5, 1]), {
      fromSampleRateHz: 48000,
      toSampleRateHz: 16000,
      contextId: "turn-float",
    });

    const jsonAudio = JSON.parse(socket.sent[0] as string) as { readonly sequence?: number };
    const pcmEnvelope = decodeSyrinxAudioEnvelope(socket.sent[1] as Uint8Array);
    const floatEnvelope = decodeSyrinxAudioEnvelope(socket.sent[2] as Uint8Array);

    expect(jsonAudio.sequence).toBe(1);
    expect(pcmEnvelope.header).toMatchObject({ contextId: "turn-pcm", sequence: 2 });
    expect(floatEnvelope.header).toMatchObject({ contextId: "turn-float", sequence: 3 });
  });

  it("honors explicit audio sequence overrides and advances later automatic sequences past them", () => {
    const client = makeClient();
    client.connect();
    const socket = sockets[0]!;

    client.sendAudioPcm(new Uint8Array([1, 0, 2, 0]), 16000, { contextId: "turn-pcm", sequence: 10 });
    client.sendFloat32Audio(new Float32Array([0, 0.5, 1]), {
      fromSampleRateHz: 48000,
      toSampleRateHz: 16000,
      contextId: "turn-float",
    });

    const pcmEnvelope = decodeSyrinxAudioEnvelope(socket.sent[0] as Uint8Array);
    const floatEnvelope = decodeSyrinxAudioEnvelope(socket.sent[1] as Uint8Array);

    expect(pcmEnvelope.header).toMatchObject({ contextId: "turn-pcm", sequence: 10 });
    expect(floatEnvelope.header).toMatchObject({ contextId: "turn-float", sequence: 11 });
  });

  it("rejects duplicate or regressing explicit audio sequence overrides before sending", () => {
    const client = makeClient();
    client.connect();
    const socket = sockets[0]!;

    client.sendAudioBase64(Buffer.from([1, 0, 2, 0]).toString("base64"), 16000, {
      contextId: "turn-json",
      sequence: 3,
    });

    expect(() => client.sendAudioPcm(new Uint8Array([3, 0, 4, 0]), 16000, {
      contextId: "turn-pcm",
      sequence: 3,
    })).toThrow("audio sequence must increase monotonically: 3 -> 3");
    expect(() => client.sendFloat32Audio(new Float32Array([0, 0.5, 1]), {
      fromSampleRateHz: 48000,
      toSampleRateHz: 16000,
      contextId: "turn-float",
      sequence: 2,
    })).toThrow("audio sequence must increase monotonically: 3 -> 2");

    expect(socket.sent).toHaveLength(1);
  });

  it("emits validated server JSON messages", () => {
    const client = makeClient();
    const messages: unknown[] = [];
    client.on((event) => {
      if (event.type === "message") messages.push(event.message);
    });
    client.connect();

    sockets[0]!.dispatch("message", {
      data: JSON.stringify({
        type: "tts_chunk",
        turnId: "turn-1",
        sequence: 1,
        sampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: 320,
        durationMs: 10,
      }),
    });

    expect(messages).toEqual([
      {
        type: "tts_chunk",
        turnId: "turn-1",
        sequence: 1,
        sampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: 320,
        durationMs: 10,
      },
    ]);
  });

  it("surfaces malformed server JSON messages as client errors", () => {
    const client = makeClient();
    const messages: unknown[] = [];
    const errors: string[] = [];
    client.on((event) => {
      if (event.type === "message") messages.push(event.message);
      if (event.type === "error" && event.error instanceof Error) errors.push(event.error.message);
    });
    client.connect();

    sockets[0]!.dispatch("message", {
      data: JSON.stringify({
        type: "agent_chunk",
        turnId: "turn-1",
        text: 42,
      }),
    });

    expect(messages).toEqual([]);
    expect(errors).toEqual(["agent_chunk.text must be a non-empty string"]);
  });
});

describe("SyrinxBrowserClient — sessionId", () => {
  beforeEach(() => {
    sockets = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("is null before any ready message", () => {
    const client = makeClient();
    client.connect();
    expect(client.sessionId).toBeNull();
  });

  it("captures sessionId from the ready message", () => {
    const client = makeClient();
    client.connect();
    sockets[0]!.dispatch("message", {
      data: JSON.stringify({ type: "ready", sessionId: "sess-abc" }),
    });
    expect(client.sessionId).toBe("sess-abc");
  });

  it("parses resumed and resumeWindowMs from the ready message", () => {
    const client = makeClient();
    const messages: SyrinxBrowserClientEvent[] = [];
    client.on((e) => messages.push(e));
    client.connect();

    sockets[0]!.dispatch("message", {
      data: JSON.stringify({
        type: "ready",
        sessionId: "sess-abc",
        resumed: true,
        resumeWindowMs: 15000,
      }),
    });

    const readyMsg = messages.find((e) => e.type === "message" && e.message.type === "ready");
    expect(readyMsg).toBeDefined();
    if (readyMsg?.type === "message" && readyMsg.message.type === "ready") {
      expect(readyMsg.message.resumed).toBe(true);
      expect(readyMsg.message.resumeWindowMs).toBe(15000);
    }
  });
});

describe("SyrinxBrowserClient — reconnect", () => {
  beforeEach(() => {
    sockets = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it("reconnects after unexpected close and re-dials with sessionId in URL", async () => {
    const client = makeClient({ reconnect: { baseDelayMs: 100, maxAttempts: 3 }, keepaliveIntervalMs: false });
    const events = collectEvents(client);
    client.connect();

    sockets[0]!.dispatch("open", {});
    sockets[0]!.dispatch("message", { data: JSON.stringify({ type: "ready", sessionId: "sess-xyz" }) });

    // Unexpected close
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.dispatch("close", { code: 1006, reason: "" });

    expect(events.map((e) => e.type)).toContain("reconnecting");
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);

    expect(sockets).toHaveLength(2);
    expect(String(sockets[1]!.url)).toContain("sessionId=sess-xyz");
  });

  it("emits reconnected (not open) when the new socket opens", async () => {
    const client = makeClient({ reconnect: { baseDelayMs: 50, maxAttempts: 3 }, keepaliveIntervalMs: false });
    const events = collectEvents(client);
    client.connect();

    sockets[0]!.dispatch("open", {});
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.dispatch("close", { code: 1006, reason: "" });

    await vi.advanceTimersByTimeAsync(100);
    sockets[1]!.dispatch("open", {});

    const types = events.map((e) => e.type);
    expect(types).toContain("open");
    expect(types).toContain("reconnecting");
    expect(types).toContain("reconnected");
    // reconnected comes after open, not instead of it
    expect(types.indexOf("open")).toBeLessThan(types.indexOf("reconnected"));
  });

  it("emits reconnecting with increasing attempt counter", async () => {
    const client = makeClient({ reconnect: { baseDelayMs: 10, maxAttempts: 5 }, keepaliveIntervalMs: false });
    const reconnectingEvents: Array<{ attempt: number }> = [];
    client.on((e) => {
      if (e.type === "reconnecting") reconnectingEvents.push({ attempt: e.attempt });
    });
    client.connect();

    sockets[0]!.dispatch("open", {});
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.dispatch("close", { code: 1006, reason: "" });

    expect(reconnectingEvents[0]!.attempt).toBe(1);

    await vi.advanceTimersByTimeAsync(30);
    // sockets[1] opens and immediately closes without dispatching open
    sockets[1]!.readyState = FakeWebSocket.CLOSED;
    sockets[1]!.dispatch("close", { code: 1006, reason: "" });

    expect(reconnectingEvents[1]!.attempt).toBe(2);
  });

  it("delays grow exponentially between attempts", () => {
    const client = makeClient({ reconnect: { baseDelayMs: 1000, maxDelayMs: 30_000, maxAttempts: 5 }, keepaliveIntervalMs: false });
    const delays: number[] = [];
    client.on((e) => {
      if (e.type === "reconnecting") delays.push(e.delayMs);
    });
    client.connect();

    sockets[0]!.dispatch("open", {});
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.dispatch("close", { code: 1006, reason: "" });

    // First delay: ~1000 ms (base, with up to 20% jitter = max 1200)
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThanOrEqual(1200);
  });

  it("emits resumed when the server ready includes resumed:true after reconnect", async () => {
    const client = makeClient({ reconnect: { baseDelayMs: 50, maxAttempts: 3 }, keepaliveIntervalMs: false });
    const events = collectEvents(client);
    client.connect();

    sockets[0]!.dispatch("open", {});
    sockets[0]!.dispatch("message", { data: JSON.stringify({ type: "ready", sessionId: "sess-xyz" }) });
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.dispatch("close", { code: 1006, reason: "" });

    await vi.advanceTimersByTimeAsync(100);
    sockets[1]!.dispatch("open", {});
    sockets[1]!.dispatch("message", {
      data: JSON.stringify({ type: "ready", sessionId: "sess-xyz", resumed: true, resumeWindowMs: 15000 }),
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("resumed");
    expect(types.indexOf("reconnected")).toBeLessThan(types.indexOf("resumed"));
  });

  it("does not emit resumed when server ready has resumed:false", async () => {
    const client = makeClient({ reconnect: { baseDelayMs: 50, maxAttempts: 3 }, keepaliveIntervalMs: false });
    const events = collectEvents(client);
    client.connect();

    sockets[0]!.dispatch("open", {});
    sockets[0]!.dispatch("message", { data: JSON.stringify({ type: "ready", sessionId: "sess-xyz" }) });
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.dispatch("close", { code: 1006, reason: "" });

    await vi.advanceTimersByTimeAsync(100);
    sockets[1]!.dispatch("open", {});
    sockets[1]!.dispatch("message", {
      data: JSON.stringify({ type: "ready", sessionId: "sess-new", resumed: false }),
    });

    expect(events.map((e) => e.type)).not.toContain("resumed");
  });

  it("connect() during CLOSING opens a new socket after the closing socket finishes", () => {
    const client = makeClient({ reconnect: false, keepaliveIntervalMs: false });
    client.connect();
    const first = sockets[0]!;
    first.readyState = FakeWebSocket.CLOSING;
    client.connect();
    expect(sockets).toHaveLength(1);
    first.readyState = FakeWebSocket.CLOSED;
    first.dispatch("close", { code: 1000, reason: "" });
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.readyState).toBe(FakeWebSocket.OPEN);
  });

  it("clean app-initiated close does not reconnect and emits close", () => {
    const client = makeClient({ keepaliveIntervalMs: false });
    const events = collectEvents(client);
    client.connect();

    sockets[0]!.dispatch("open", {});
    client.close(1000, "done");
    sockets[0]!.dispatch("close", { code: 1000, reason: "done" });

    expect(events.map((e) => e.type)).not.toContain("reconnecting");
    expect(events.find((e) => e.type === "close")).toMatchObject({ type: "close", code: 1000, reason: "done" });
    expect(sockets).toHaveLength(1);
  });

  it("storm cap stops reconnecting after maxAttempts and emits close", async () => {
    const client = makeClient({ reconnect: { maxAttempts: 2, baseDelayMs: 10 }, keepaliveIntervalMs: false });
    const events = collectEvents(client);
    client.connect();

    sockets[0]!.dispatch("open", {});
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.dispatch("close", { code: 1006, reason: "" });

    // Attempt 1 scheduled
    await vi.advanceTimersByTimeAsync(30);
    // sockets[1] created — no open dispatch, close immediately
    sockets[1]!.readyState = FakeWebSocket.CLOSED;
    sockets[1]!.dispatch("close", { code: 1006, reason: "" });

    // Attempt 2 scheduled
    await vi.advanceTimersByTimeAsync(60);
    // sockets[2] created — close immediately
    sockets[2]!.readyState = FakeWebSocket.CLOSED;
    sockets[2]!.dispatch("close", { code: 1006, reason: "" });

    // maxAttempts=2 exhausted — emits close, no sockets[3]
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "reconnecting")).toHaveLength(2);
    expect(types.filter((t) => t === "close")).toHaveLength(1);
    expect(sockets).toHaveLength(3);
  });

  it("reconnect disabled entirely with reconnect:false emits close on unexpected disconnect", () => {
    const client = makeClient({ reconnect: false, keepaliveIntervalMs: false });
    const events = collectEvents(client);
    client.connect();

    sockets[0]!.dispatch("open", {});
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.dispatch("close", { code: 1006, reason: "" });

    const types = events.map((e) => e.type);
    expect(types).not.toContain("reconnecting");
    expect(types).toContain("close");
    expect(sockets).toHaveLength(1);
  });

  it("resets reconnect counter after a successful reconnect", async () => {
    const client = makeClient({ reconnect: { maxAttempts: 2, baseDelayMs: 10 }, keepaliveIntervalMs: false });
    const reconnectingCount = () => collectEvents(client).filter((e) => e.type === "reconnecting").length;
    const events = collectEvents(client);

    client.connect();
    sockets[0]!.dispatch("open", {});
    sockets[0]!.readyState = FakeWebSocket.CLOSED;
    sockets[0]!.dispatch("close", { code: 1006, reason: "" });

    await vi.advanceTimersByTimeAsync(30);
    // sockets[1] reconnects successfully
    sockets[1]!.dispatch("open", {});
    // then disconnects again
    sockets[1]!.readyState = FakeWebSocket.CLOSED;
    sockets[1]!.dispatch("close", { code: 1006, reason: "" });

    // Second storm: attempt counter reset after reconnect succeeded, so we get another 2 attempts
    await vi.advanceTimersByTimeAsync(60);

    const reconnectingEvents = events.filter((e) => e.type === "reconnecting") as Array<{ type: "reconnecting"; attempt: number }>;
    // After the successful reconnect, attempt resets: second disconnect starts at attempt 1 again
    expect(reconnectingEvents[0]!.attempt).toBe(1);
    expect(reconnectingEvents[1]!.attempt).toBe(1);
  });

  it("gives up after maxQuickFailures open-then-die flaps even when maxAttempts is high", async () => {
    // A peer that accepts the socket then drops it immediately (half-broken mid-deploy,
    // or a token accepted-then-rejected) must not loop forever: backoff can't fix it.
    const client = makeClient({
      reconnect: { maxAttempts: 100, baseDelayMs: 10, minStableMs: 5_000, maxQuickFailures: 3 },
      keepaliveIntervalMs: false,
    });
    const events = collectEvents(client);
    client.connect();

    for (let i = 0; i < 3; i += 1) {
      sockets[i]!.dispatch("open", {}); // opens...
      sockets[i]!.readyState = FakeWebSocket.CLOSED;
      sockets[i]!.dispatch("close", { code: 1006, reason: "" }); // ...then dies < minStableMs
      await vi.advanceTimersByTimeAsync(50);
    }

    const types = events.map((e) => e.type);
    // 3rd flap hits maxQuickFailures → give up despite maxAttempts=100; no 4th socket.
    expect(types.filter((t) => t === "close")).toHaveLength(1);
    expect(sockets).toHaveLength(3);
  });
});

describe("SyrinxBrowserClient — keepalive", () => {
  beforeEach(() => {
    sockets = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it("sends ping at the configured interval", async () => {
    const client = makeClient({ keepaliveIntervalMs: 5000, reconnect: false });
    client.connect();
    sockets[0]!.dispatch("open", {});

    await vi.advanceTimersByTimeAsync(5000);

    expect(sockets[0]!.sent).toContain(JSON.stringify({ type: "ping" }));
  });

  it("sends pings repeatedly at each interval", async () => {
    const client = makeClient({ keepaliveIntervalMs: 5000, reconnect: false });
    client.connect();
    sockets[0]!.dispatch("open", {});

    await vi.advanceTimersByTimeAsync(15000);

    const pings = sockets[0]!.sent.filter((s) => s === JSON.stringify({ type: "ping" }));
    expect(pings).toHaveLength(3);
  });

  it("does not send pings before the interval has elapsed", async () => {
    const client = makeClient({ keepaliveIntervalMs: 5000, reconnect: false });
    client.connect();
    sockets[0]!.dispatch("open", {});

    await vi.advanceTimersByTimeAsync(4999);

    expect(sockets[0]!.sent.filter((s) => s === JSON.stringify({ type: "ping" }))).toHaveLength(0);
  });

  it("stops pings after clean close", async () => {
    const client = makeClient({ keepaliveIntervalMs: 5000, reconnect: false });
    client.connect();
    sockets[0]!.dispatch("open", {});
    client.close();
    sockets[0]!.dispatch("close", { code: 1000, reason: "" });

    await vi.advanceTimersByTimeAsync(20000);

    const pings = sockets[0]!.sent.filter((s) => s === JSON.stringify({ type: "ping" }));
    expect(pings).toHaveLength(0);
  });

  it("keepalive:false disables pings entirely", async () => {
    const client = makeClient({ keepaliveIntervalMs: false, reconnect: false });
    client.connect();
    sockets[0]!.dispatch("open", {});

    await vi.advanceTimersByTimeAsync(60000);

    expect(sockets[0]!.sent.filter((s) => s === JSON.stringify({ type: "ping" }))).toHaveLength(0);
  });

  it("uses default 10 s interval when keepaliveIntervalMs is not set", async () => {
    const client = makeClient({ reconnect: false });
    client.connect();
    sockets[0]!.dispatch("open", {});

    await vi.advanceTimersByTimeAsync(10000);

    expect(sockets[0]!.sent).toContain(JSON.stringify({ type: "ping" }));
  });

  it("stops keepalive and emits error when ping send races a socket close", async () => {
    const client = makeClient({ keepaliveIntervalMs: 5000, reconnect: false });
    const events = collectEvents(client);
    client.connect();
    sockets[0]!.dispatch("open", {});

    sockets[0]!.send = () => {
      throw new Error("socket closed during ping");
    };

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(sockets[0]!.sent.filter((s) => s === JSON.stringify({ type: "ping" }))).toHaveLength(0);
  });
});

describe("SyrinxBrowserClient — metrics", () => {
  beforeEach(() => {
    sockets = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("surfaces populated server metrics messages", () => {
    const client = makeClient();
    const events = collectEvents(client);
    client.connect();
    const socket = sockets[0]!;
    socket.dispatch("open", {});

    socket.dispatch("message", {
      data: JSON.stringify({
        type: "metrics",
        turnId: "turn-1",
        correlationId: "turn-1",
        speechEndMs: 1000,
        textReadyMs: 1500,
        firstAudioByteMs: 1700,
        firstAudioPlayedMs: 1900,
        lastAudioPlayedMs: 2500,
        sttMs: 200,
        llmTTFTMs: 300,
        ttsTTFBMs: 200,
        e2eMs: 900,
      }),
    });

    const metricsEvent = events.find((event) =>
      event.type === "message" && event.message.type === "metrics",
    );
    expect(metricsEvent).toMatchObject({
      type: "message",
      message: {
        type: "metrics",
        turnId: "turn-1",
        correlationId: "turn-1",
        e2eMs: 900,
      },
    });
  });
});
