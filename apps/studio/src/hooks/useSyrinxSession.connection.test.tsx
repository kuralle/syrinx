// SPDX-License-Identifier: MIT
//
// The three connection failures, reproduced against real stub servers.
//
// Deliberately NOT a fake client: how the browser reports a dead port, a rejected
// upgrade and a socket that opens then dies is exactly the thing under test, and a
// hand-written fake would encode the assumption rather than check it. So a real
// `ws`/`http` server stands in for the backend and the real browser-client drives
// a real socket. Only the two browser capabilities jsdom lacks — Web Audio and a
// microphone — are stubbed, and text mode means the microphone is never asked for.

import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { useSyrinxSession } from "./useSyrinxSession";

class FakeAudioContext {
  sampleRate = 48000;
  destination = {};
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
  createAnalyser = () => ({ fftSize: 0, connect: () => undefined, disconnect: () => undefined });
  createScriptProcessor = () => ({
    onaudioprocess: null,
    connect: () => undefined,
    disconnect: () => undefined,
  });
}

const listening: Server[] = [];
const sockets: WebSocketServer[] = [];

async function httpServer(handler: RequestListener): Promise<number> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  listening.push(server);
  return (server.address() as AddressInfo).port;
}

/** A port that was bound and released, so nothing is listening on it. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(async () => {
  for (const wss of sockets.splice(0)) await new Promise<void>((r) => wss.close(() => r()));
  for (const server of listening.splice(0)) await new Promise<void>((r) => server.close(() => r()));
});

async function connectTo(url: string) {
  const hook = renderHook(() => useSyrinxSession(url));
  // Text mode: no microphone is requested, so jsdom's missing getUserMedia cannot
  // fail the connection for an unrelated reason.
  act(() => hook.result.current.setMode("text"));
  await act(async () => {
    await hook.result.current.connect();
  });
  return hook;
}

describe("useSyrinxSession — naming a connection failure against a stub server", () => {
  it("calls a dead port refused, not an error", async () => {
    const port = await deadPort();
    const { result } = await connectTo(`ws://127.0.0.1:${String(port)}/ws`);

    await waitFor(() => expect(result.current.failure).toBeDefined(), { timeout: 10_000 });
    expect(result.current.failure?.kind).toBe("refused");
    expect(result.current.failure?.wsUrl).toBe(`ws://127.0.0.1:${String(port)}/ws`);

    act(() => result.current.disconnect());
  }, 15_000);

  it("calls a live server on the wrong path upgrade-rejected", async () => {
    // Answers plain HTTP, refuses every upgrade — exactly a worker whose voice
    // route is somewhere else.
    const port = await httpServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    const { result } = await connectTo(`ws://127.0.0.1:${String(port)}/wrong-path`);

    await waitFor(() => expect(result.current.failure).toBeDefined(), { timeout: 10_000 });
    expect(result.current.failure?.kind).toBe("upgrade-rejected");

    act(() => result.current.disconnect());
  }, 15_000);

  it("calls a socket that opens then dies agent-init-failed, and keeps the reason", async () => {
    const port = await httpServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const server = listening.at(-1)!;
    const wss = new WebSocketServer({ server });
    sockets.push(wss);
    // The real shape of a startup failure: server-websocket's sendStartupError
    // sends this and then closes, without ever sending `ready`.
    wss.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "error",
          component: "session",
          category: "initialization",
          message: "DEEPGRAM_API_KEY is not set",
        }),
      );
      socket.close(1011, "session failed to start");
    });

    const { result } = await connectTo(`ws://127.0.0.1:${String(port)}/ws`);

    await waitFor(() => expect(result.current.failure).toBeDefined(), { timeout: 10_000 });
    expect(result.current.failure?.kind).toBe("agent-init-failed");
    expect(result.current.failure?.serverError).toEqual({
      component: "session",
      category: "initialization",
      message: "DEEPGRAM_API_KEY is not set",
    });

    act(() => result.current.disconnect());
  }, 15_000);

  it("treats a dropped ready session as a drop, not a failed connection", async () => {
    // The distinction the resume window depends on: this session existed, so what
    // the reader needs is the remaining window, not "your path is wrong".
    const port = await httpServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const wss = new WebSocketServer({ server: listening.at(-1)! });
    sockets.push(wss);
    wss.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "ready",
          sessionId: "s1",
          resumeWindowMs: 60_000,
          audio: {
            inputSampleRateHz: 16000,
            outputSampleRateHz: 24000,
            encoding: "pcm_s16le",
            channels: 1,
          },
        }),
      );
      setTimeout(() => socket.close(1001, "going away"), 50);
    });

    const { result } = await connectTo(`ws://127.0.0.1:${String(port)}/ws`);

    await waitFor(() => expect(result.current.sessionId).toBe("s1"), { timeout: 10_000 });
    await waitFor(() => expect(result.current.disconnectedAtMs).toBeDefined(), { timeout: 10_000 });
    expect(result.current.failure).toBeUndefined();
    expect(result.current.record.config.resumeWindowMs).toBe(60_000);

    act(() => result.current.disconnect());
  }, 15_000);
});
