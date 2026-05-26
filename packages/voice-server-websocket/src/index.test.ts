// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Route, VoiceAgentSession, type UserAudioReceivedPacket, type UserTextReceivedPacket } from "@asyncdot/voice";
import { createVoiceWebSocketServer } from "./index.js";

function websocketUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

async function openClientAndReadReady(url: string): Promise<[WebSocket, any]> {
  const socket = new WebSocket(url);
  const ready = readJson(socket);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return [socket, await ready];
}

async function readJson(socket: WebSocket): Promise<any> {
  return await new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe("createVoiceWebSocketServer", () => {
  it("bridges binary browser audio into v2 user.audio_received packets", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client, ready] = await openClientAndReadReady(websocketUrl(address.port));
    expect(ready).toMatchObject({ type: "ready", sessionId: "turn-test" });

    client.send(Buffer.from([1, 2, 3, 4]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([
      expect.objectContaining({
        kind: "user.audio_received",
        contextId: "turn-test",
        audio: new Uint8Array([1, 2, 3, 4]),
      }),
    ]);

    client.close();
    await server.close();
  });

  it("bridges browser text messages and streams TTS audio back to the socket", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const textPackets: UserTextReceivedPacket[] = [];
    session.bus.on("user.text_received", (pkt) => {
      textPackets.push(pkt as UserTextReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));

    const audioMessage = new Promise<Buffer>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) resolve(data as Buffer);
      });
    });

    client.send(JSON.stringify({ type: "text", text: "hello", contextId: "turn-2" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-2",
      timestampMs: Date.now(),
      audio: new Uint8Array([8, 9, 10]),
    });

    expect(textPackets).toEqual([
      expect.objectContaining({
        kind: "user.text_received",
        contextId: "turn-2",
        text: "hello",
      }),
    ]);
    await expect(audioMessage).resolves.toEqual(Buffer.from([8, 9, 10]));

    client.close();
    await server.close();
  });

  it("forwards VAD-driven assistant interruption as audio clear events", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const clearMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "audio_clear") resolve(message);
      });
    });

    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
    });

    await expect(clearMessage).resolves.toEqual({
      type: "audio_clear",
      turnId: "assistant-turn",
      reason: "barge_in",
    });

    client.close();
    await server.close();
  });

  it("forwards VAD speech boundary events to websocket clients", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const messages: any[] = [];
    const speechMessages = new Promise<any[]>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "speech_started" || message.type === "speech_ended") {
          messages.push(message);
        }
        if (messages.length === 2) resolve(messages);
      });
    });

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-2",
      timestampMs: Date.now(),
      confidence: 0.91,
    });
    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-2",
      timestampMs: Date.now(),
    });

    await expect(speechMessages).resolves.toEqual([
      { type: "speech_started", turnId: "turn-2" },
      { type: "speech_ended", turnId: "turn-2" },
    ]);

    client.close();
    await server.close();
  });
});
