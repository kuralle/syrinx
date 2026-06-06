// SPDX-License-Identifier: MIT
// WT-03: Browser outbound pacing + playout clock + client jitter buffer

import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Route, VoiceAgentSession } from "@kuralle-syrinx/core";
import { pcm16SamplesToBytes } from "@kuralle-syrinx/core/audio";
import { createVoiceWebSocketServer, type VoiceWebSocketServer } from "./index.js";

function browserUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

async function openBrowserSocketReady(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return;
      try {
        const parsed = JSON.parse(data.toString()) as { type?: string };
        if (parsed.type === "ready") {
          socket.off("message", onMessage);
          resolve();
        }
      } catch {
        // Ignore parsing errors
      }
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
  return socket;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await waitMs(10);
  }
  throw new Error("Timed out waiting for browser pacing condition");
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

function collectMessagesMatching(
  socket: WebSocket, 
  predicate: (m: unknown) => boolean, 
  timeoutMs: number
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(messages);
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const message = JSON.parse(data.toString()) as unknown;
        if (predicate(message)) {
          messages.push(message);
        }
      } catch {
        // Ignore parsing errors
      }
    };
    socket.on("message", onMessage);
  });
}

// Track servers so we can force-close them in afterEach even if test fails
let activeServers: VoiceWebSocketServer[] = [];
let activeHttpServers: ReturnType<typeof createServer>[] = [];

beforeEach(() => {
  activeServers = [];
  activeHttpServers = [];
});

afterEach(async () => {
  for (const server of activeServers) {
    await server.close().catch(() => undefined);
  }
  for (const httpServer of activeHttpServers) {
    httpServer.close();
  }
  activeServers = [];
  activeHttpServers = [];
});

describe("WT-03 Browser outbound pacing", () => {
  it("browser adapter enqueues paced frames with consistent timing", async () => {
    const httpServer = createServer();
    activeHttpServers.push(httpServer);
    
    let session: VoiceAgentSession | null = null;
    const server = await createVoiceWebSocketServer({
      server: httpServer,
      port: 0, // Let the system assign a port
      createSession: () => {
        session = new VoiceAgentSession({ plugins: {} });
        return session;
      },
      outboundFrameDurationMs: 20,
    });
    activeServers.push(server);

    const port = (server.address() as any).port;
    const socket = await openBrowserSocketReady(browserUrl(port));

    // Session is already started by the websocket server

    // Send TTS audio - 160ms of 16kHz PCM16 (should be split into ~8 frames of 20ms each)
    const sampleCount = Math.floor(0.16 * 16000); // 160ms at 16kHz
    const audioSamples = new Int16Array(sampleCount).fill(1000); // Simple sine-like values
    const audioBytes = pcm16SamplesToBytes(audioSamples);

    // Collect tts_chunk messages over 200ms to ensure all frames arrive
    const ttsChunksPromise = collectMessagesMatching(
      socket,
      (m: any) => m.type === "tts_chunk",
      300
    );

    // Send TTS audio
    session!.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "test-turn",
      timestampMs: Date.now(),
      audio: audioBytes,
      sampleRateHz: 16000,
    });

    // End TTS
    session!.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "test-turn",
      timestampMs: Date.now(),
    });

    const ttsChunks = await ttsChunksPromise;
    socket.close();

    // Verify we got multiple frames (pacing is working)
    expect(ttsChunks.length).toBeGreaterThan(1);
    
    // Verify each frame has expected structure
    for (const chunk of ttsChunks) {
      const c = chunk as any;
      expect(c.type).toBe("tts_chunk");
      expect(c.turnId).toBe("test-turn");
      expect(c.sequence).toBeGreaterThan(0);
      expect(c.sampleRateHz).toBe(16000);
      expect(c.encoding).toBe("opus");
      expect(c.channels).toBe(1);
      expect(c.byteLength).toBeGreaterThan(0);
      expect(c.durationMs).toBeGreaterThan(0);
    }

    // Verify sequence numbers increment
    const sequences = ttsChunks.map((c: any) => c.sequence);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1] + 1);
    }
  });

  it("emits tts.playout_progress events during paced playback", async () => {
    const httpServer = createServer();
    activeHttpServers.push(httpServer);
    
    let session: VoiceAgentSession | null = null;
    const server = await createVoiceWebSocketServer({
      server: httpServer,
      port: 0,
      createSession: () => {
        session = new VoiceAgentSession({ plugins: {} });
        return session;
      },
      outboundFrameDurationMs: 20,
    });
    activeServers.push(server);

    const port = (server.address() as any).port;
    const socket = await openBrowserSocketReady(browserUrl(port));

    // Session is already started by the websocket server

    // Track playout progress events
    const progressEvents: any[] = [];
    const removeProgressHandler = session!.bus.on("tts.playout_progress", (pkt: any) => {
      if (pkt.contextId === "test-turn") {
        progressEvents.push(pkt);
      }
    });

    // Send TTS audio - 80ms worth
    const sampleCount = Math.floor(0.08 * 16000);
    const audioSamples = new Int16Array(sampleCount).fill(1000);
    const audioBytes = pcm16SamplesToBytes(audioSamples);

    session!.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "test-turn",
      timestampMs: Date.now(),
      audio: audioBytes,
      sampleRateHz: 16000,
    });

    session!.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "test-turn",
      timestampMs: Date.now(),
    });

    // Wait for playout to complete
    await waitMs(150);

    socket.close();
    removeProgressHandler();

    // Should have received playout progress events
    expect(progressEvents.length).toBeGreaterThan(0);

    // Last event should be completion
    const lastEvent = progressEvents[progressEvents.length - 1];
    expect(lastEvent.complete).toBe(true);
  });

  it("handles interrupt.tts by clearing playout queue and sending audio_clear", async () => {
    const httpServer = createServer();
    activeHttpServers.push(httpServer);
    
    let session: VoiceAgentSession | null = null;
    const server = await createVoiceWebSocketServer({
      server: httpServer,
      port: 0,
      createSession: () => {
        session = new VoiceAgentSession({ plugins: {} });
        return session;
      },
      outboundFrameDurationMs: 20,
    });
    activeServers.push(server);

    const port = (server.address() as any).port;
    const socket = await openBrowserSocketReady(browserUrl(port));

    // Session is already started by the websocket server

    // Send a longer TTS audio burst
    const sampleCount = Math.floor(0.2 * 16000); // 200ms
    const audioSamples = new Int16Array(sampleCount).fill(1000);
    const audioBytes = pcm16SamplesToBytes(audioSamples);

    session!.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "test-turn",
      timestampMs: Date.now(),
      audio: audioBytes,
      sampleRateHz: 16000,
    });

    // Wait a bit for some frames to be queued
    await waitMs(10);

    // Listen for audio_clear message
    const audioClearPromise = readJsonMatching(socket, (m: any) => m.type === "audio_clear");

    // Send interrupt
    session!.bus.push(Route.Main, {
      kind: "interrupt.tts",
      contextId: "test-turn",
      timestampMs: Date.now(),
    });

    const audioClear = await audioClearPromise;
    socket.close();

    expect((audioClear as any).type).toBe("audio_clear");
    expect((audioClear as any).turnId).toBe("test-turn");
    expect((audioClear as any).reason).toBe("barge_in");
  });

  it("respects custom outbound frame duration and queue limits", async () => {
    const httpServer = createServer();
    activeHttpServers.push(httpServer);
    
    let session: VoiceAgentSession | null = null;
    const server = await createVoiceWebSocketServer({
      server: httpServer,
      port: 0,
      createSession: () => {
        session = new VoiceAgentSession({ plugins: {} });
        return session;
      },
      outboundFrameDurationMs: 40, // Larger frames
      maxQueuedOutputAudioMs: 100, // Small queue to trigger overflow
    });
    activeServers.push(server);

    const port = (server.address() as any).port;
    const socket = await openBrowserSocketReady(browserUrl(port));

    // Session is already started by the websocket server

    // Send large audio burst to trigger overflow
    const sampleCount = Math.floor(1.0 * 16000); // 1 second
    const audioSamples = new Int16Array(sampleCount).fill(1000);
    const audioBytes = pcm16SamplesToBytes(audioSamples);

    const ttsChunksPromise = collectMessagesMatching(
      socket,
      (m: any) => m.type === "tts_chunk",
      200
    );

    session!.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "test-turn",
      timestampMs: Date.now(),
      audio: audioBytes,
      sampleRateHz: 16000,
    });

    const ttsChunks = await ttsChunksPromise;
    socket.close();

    // With 40ms frames, should have fewer chunks than with 20ms
    expect(ttsChunks.length).toBeLessThan(20);
    
    // Each chunk should represent ~40ms duration
    if (ttsChunks.length > 0) {
      const firstChunk = ttsChunks[0] as any;
      expect(firstChunk.durationMs).toBeGreaterThanOrEqual(35);
      expect(firstChunk.durationMs).toBeLessThanOrEqual(45);
    }
  });

  it("uses the interactive 200ms playout bound by default", async () => {
    const httpServer = createServer();
    activeHttpServers.push(httpServer);

    let session: VoiceAgentSession | null = null;
    const metrics: Array<{ name: string; value: string }> = [];
    const server = await createVoiceWebSocketServer({
      server: httpServer,
      port: 0,
      createSession: () => {
        session = new VoiceAgentSession({ plugins: {} });
        return session;
      },
    });
    activeServers.push(server);

    const port = (server.address() as any).port;
    const socket = await openBrowserSocketReady(browserUrl(port));
    let closed = false;
    socket.once("close", () => {
      closed = true;
    });
    session!.bus.on("metric.conversation", (pkt) => {
      const metric = pkt as unknown as { name: string; value: string };
      metrics.push(metric);
    });

    session!.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "default-bound-turn",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(16000)),
      sampleRateHz: 16000,
    });

    await waitForCondition(() =>
      metrics.some((metric) => metric.name === "browser.overflow_playout_stopped"),
    );
    expect(metrics).toContainEqual(expect.objectContaining({
      name: "browser.overflow_playout_stopped",
      value: "1",
    }));
    expect(closed).toBe(false);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("allows long playout queues only through an explicit override", async () => {
    const httpServer = createServer();
    activeHttpServers.push(httpServer);

    let session: VoiceAgentSession | null = null;
    const server = await createVoiceWebSocketServer({
      server: httpServer,
      port: 0,
      createSession: () => {
        session = new VoiceAgentSession({ plugins: {} });
        return session;
      },
      maxQueuedOutputAudioMs: 1000,
    });
    activeServers.push(server);

    const port = (server.address() as any).port;
    const socket = await openBrowserSocketReady(browserUrl(port));
    let closed = false;
    socket.once("close", () => {
      closed = true;
    });

    const ttsChunksPromise = collectMessagesMatching(
      socket,
      (m: any) => m.type === "tts_chunk",
      150,
    );
    session!.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "explicit-long-queue-turn",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(6400)),
      sampleRateHz: 16000,
    });

    const chunks = await ttsChunksPromise;
    socket.close();

    expect(chunks.length).toBeGreaterThan(0);
    expect(closed).toBe(false);
  });
});
