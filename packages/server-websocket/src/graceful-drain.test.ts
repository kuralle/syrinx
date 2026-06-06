// SPDX-License-Identifier: MIT
// WT-04: Graceful connection draining on shutdown

import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Route, VoiceAgentSession } from "@kuralle-syrinx/core";
import { pcm16SamplesToBytes } from "@kuralle-syrinx/core/audio";
import { createTwilioMediaStreamServer, type TwilioMediaStreamServer } from "./twilio.js";
import { createVoiceWebSocketServer, type VoiceWebSocketServer } from "./index.js";

function twilioUrl(port: number): string {
  return `ws://127.0.0.1:${port}/twilio`;
}

function browserUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return socket;
}

// The browser server sends `ready` proactively right after the upgrade. The message
// listener must therefore be attached BEFORE the socket opens — `ws` does not buffer
// events for an absent listener, so `await openSocket()` then a later `readJsonMatching`
// races and drops `ready`, hanging the test. (Telephony servers don't send anything
// until the client's `start`, so they aren't exposed to this.)
async function openBrowserSocketReady(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return;
      if ((JSON.parse(data.toString()) as { type?: string }).type === "ready") {
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
  return socket;
}

function twilioStart(streamSid = "MZ-test", callSid = "CA-test"): Record<string, unknown> {
  return {
    event: "start",
    streamSid,
    start: {
      streamSid,
      callSid,
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    },
  };
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number): void => {
      if (!done) { done = true; resolve(code); }
    };
    // A graceful close sends a 1001 frame → a clean 'close' with that code (wins, since
    // the server waits for the handshake before any terminate). A non-graceful
    // terminate() RSTs the socket → the ws client surfaces ECONNRESET as an 'error'
    // that is not always followed by a timely 'close', so treat it as an abnormal 1006.
    socket.on("close", (code) => finish(code));
    socket.on("error", () => finish(1006));
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonMatching(socket: WebSocket, predicate: (m: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as unknown;
      if (!predicate(message)) return;
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

// Track servers so we can force-close them in afterEach even if test fails
let activeServers: Array<TwilioMediaStreamServer | VoiceWebSocketServer> = [];
let activeHttpServers: ReturnType<typeof createServer>[] = [];

beforeEach(() => {
  activeServers = [];
  activeHttpServers = [];
});

afterEach(async () => {
  await Promise.allSettled(activeServers.map((s) => s.close()));
  await Promise.allSettled(
    activeHttpServers.map((h) => new Promise<void>((res) => h.close(() => res()))),
  );
  activeServers = [];
  activeHttpServers = [];
});

describe("graceful connection draining (WT-04)", () => {
  it("non-graceful close terminates all clients immediately", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    activeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
    await waitMs(30);

    const closePromise = waitForClose(client);
    const before = Date.now();
    await server.close(); // non-graceful (default)
    const closeCode = await closePromise;
    const elapsed = Date.now() - before;

    // terminate() sends no close frame; client sees abnormal close (1006)
    expect(closeCode).toBe(1006);
    expect(elapsed).toBeLessThan(500);
  }, 10_000);

  it("graceful close with no pending audio sends 1001 going-away to clients", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    activeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
    await waitMs(30); // let wireSession + processMessage complete

    const closePromise = waitForClose(client);
    await server.close({ graceful: true, drainDeadlineMs: 5_000 });
    const closeCode = await closePromise;

    expect(closeCode).toBe(1001);
  }, 10_000);

  it("graceful close drains pending paced audio before sending 1001", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      outboundFrameDurationMs: 20,
      outputSampleRateHz: 8000,
      maxQueuedOutputAudioMs: 30_000,
      createSession: () => session,
    });
    activeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
    await waitMs(30);

    const mediaFrames: unknown[] = [];
    client.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as { event?: string };
      if (message.event === "media") mediaFrames.push(message);
    });

    // Push audio via the bus (bus delivers asynchronously)
    const audio80ms = pcm16SamplesToBytes(new Int16Array(640)); // 80ms at 8kHz
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test",
      timestampMs: Date.now(),
      audio: audio80ms,
      sampleRateHz: 8000,
    });

    // Wait for at least one media frame to arrive — confirms audio is in the queue
    await readJsonMatching(client, (m) => (m as { event?: string }).event === "media");

    // Now the queue has remaining frames. Graceful close should drain them then send 1001.
    const closePromise = waitForClose(client);
    await server.close({ graceful: true, drainDeadlineMs: 5_000 });
    const closeCode = await closePromise;

    expect(closeCode).toBe(1001);
    // At least one frame received before close (the one we waited for)
    expect(mediaFrames.length).toBeGreaterThan(0);
  }, 15_000);

  it("graceful close force-terminates at drainDeadlineMs for wedged consumers", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      outboundFrameDurationMs: 20,
      outputSampleRateHz: 8000,
      maxQueuedOutputAudioMs: 30_000,
      createSession: () => session,
    });
    activeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
    await waitMs(30);

    // Push 30s of audio that will NOT drain before the deadline
    const longAudio = pcm16SamplesToBytes(new Int16Array(8000 * 30)); // 30s at 8kHz
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test",
      timestampMs: Date.now(),
      audio: longAudio,
      sampleRateHz: 8000,
    });

    // Wait for first frame so audio is confirmed in the queue
    await readJsonMatching(client, (m) => (m as { event?: string }).event === "media");

    const closePromise = waitForClose(client);
    const before = Date.now();
    // 80ms deadline — far shorter than 30s of audio
    await server.close({ graceful: true, drainDeadlineMs: 80 });
    const closeCode = await closePromise;
    const elapsed = Date.now() - before;

    // Force-terminated at deadline: client sees abnormal close
    expect(closeCode).toBe(1006);
    // Should complete within a reasonable time after the deadline
    expect(elapsed).toBeLessThan(800);
  }, 10_000);

  it("createVoiceWebSocketServer graceful close sends 1001 to browser clients", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
    });
    activeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openBrowserSocketReady(browserUrl(address.port));
    const closePromise = waitForClose(client);
    await server.close({ graceful: true, drainDeadlineMs: 3_000 });
    expect(await closePromise).toBe(1001);
  }, 10_000);

  it("createVoiceWebSocketServer close() with no opts sends immediate RST (1006) to browser clients", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
    });
    activeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openBrowserSocketReady(browserUrl(address.port));
    const closePromise = waitForClose(client);
    await server.close();
    expect(await closePromise).toBe(1006);
  }, 10_000);

  it("multiple simultaneous clients all receive 1001 on graceful close", async () => {
    const server = await createTwilioMediaStreamServer({
      port: 0,
      createSession: () => new VoiceAgentSession({ plugins: {} }),
    });
    activeServers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [c1, c2] = await Promise.all([
      openSocket(twilioUrl(address.port)),
      openSocket(twilioUrl(address.port)),
    ]);
    c1.send(JSON.stringify(twilioStart("MZ-1", "CA-1")));
    c2.send(JSON.stringify(twilioStart("MZ-2", "CA-2")));
    await waitMs(40);

    const [codes] = await Promise.all([
      Promise.all([waitForClose(c1), waitForClose(c2)]),
      server.close({ graceful: true, drainDeadlineMs: 3_000 }),
    ]);

    expect(codes[0]).toBe(1001);
    expect(codes[1]).toBe(1001);
  }, 15_000);
});
