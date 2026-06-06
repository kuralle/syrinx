// SPDX-License-Identifier: MIT
//
// R-14: regression gate — the realtime package must run on workerd without
// Buffer, process, or node:crypto. Reintroducing any Node-only primitive in
// src/ should fail this test.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TurnChangePacket,
} from "@kuralle-syrinx/core";
import type { ManagedSocket, SocketData, SocketFactory } from "@kuralle-syrinx/ws";

import { bytesToBase64, fromOpenAIRealtime } from "./from-openai-realtime.js";
import { RealtimeBridge } from "./realtime-bridge.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

interface EdgeMockHarness {
  readonly factory: SocketFactory;
  readonly sent: string[];
  inject(msg: Record<string, unknown>): void;
}

function createEdgeMockHarness(): EdgeMockHarness {
  const sent: string[] = [];
  let messageHandler: ((data: SocketData, isBinary: boolean) => void) | null = null;

  const socket: ManagedSocket = {
    get isOpen() {
      return true;
    },
    send: (data: SocketData) => {
      sent.push(typeof data === "string" ? data : "");
    },
    keepAlivePing: () => {},
    verify: async () => true,
    dispose: () => {},
    onOpen: (handler) => {
      queueMicrotask(() => handler());
    },
    onMessage: (handler) => {
      messageHandler = handler;
    },
    onClose: () => {},
    onError: () => {},
  };

  return {
    factory: () => socket,
    sent,
    inject: (msg) => messageHandler?.(JSON.stringify(msg), false),
  };
}

function pcmFromSamples(samples: readonly number[]): Uint8Array {
  const pcm = Int16Array.from(samples);
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("edge safety (R-14)", () => {
  it("src/ contains no Buffer, process, or node:crypto imports", () => {
    const forbidden = [
      /\bfrom\s+["']node:crypto["']/,
      /\brequire\s*\(\s*["']node:crypto["']\s*\)/,
      /\bglobalThis\.Buffer\b/,
      /\bglobalThis\.process\b/,
      /\bprocess\.env\b/,
      /\bBuffer\.from\b/,
      /\bBuffer\.alloc\b/,
    ];
    const hits: string[] = [];
    for (const file of collectSourceFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(text)) {
          hits.push(`${path.relative(srcDir, file)}: ${pattern.source}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  // NOTE: we do NOT delete globalThis.Buffer/process here — vitest's own worker needs `process`
  // (its uncaughtException handler calls process.listeners), so deleting it crashes the runner.
  // Edge-safety is enforced statically by the source-scan above; this test proves the audio path
  // actually runs end-to-end using only the runtime-agnostic helpers.
  it("fromOpenAIRealtime + RealtimeBridge round-trip audio via runtime-agnostic helpers", async () => {
    const mock = createEdgeMockHarness();
    const adapter = fromOpenAIRealtime({
      apiKey: "edge-test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=gpt-realtime-2",
    });
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    const turnChanges: TurnChangePacket[] = [];
    const ttsAudio: TextToSpeechAudioPacket[] = [];
    bus.on("turn.change", (pkt) => { turnChanges.push(pkt as TurnChangePacket); });
    bus.on("tts.audio", (pkt) => { ttsAudio.push(pkt as TextToSpeechAudioPacket); });

    const started = bus.start();

    const initTask = bridge.initialize(bus, {});
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await initTask;

    bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: "transport-turn",
      timestampMs: Date.now(),
      audio: pcmFromSamples([100, 200, 300, 400]),
    });

    await waitFor(() =>
      mock.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === "input_audio_buffer.append"),
    );

    const providerPcm = pcmFromSamples(Array.from({ length: 960 }, (_, i) => i));
    mock.inject({ type: "response.created" });
    mock.inject({
      type: "response.output_audio.delta",
      delta: bytesToBase64(providerPcm),
    });
    mock.inject({ type: "response.done" });

    await waitFor(() => ttsAudio.length > 0 && turnChanges.length > 0);

    const contextId = turnChanges[0]!.contextId;
    expect(contextId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(ttsAudio[0]!.contextId).toBe(contextId);
    expect(ttsAudio[0]!.sampleRateHz).toBe(16_000);
    expect(ttsAudio[0]!.audio.byteLength).toBeGreaterThan(0);

    await bridge.close();
    bus.stop();
    await started;
  });
});
