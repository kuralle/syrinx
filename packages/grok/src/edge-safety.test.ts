// SPDX-License-Identifier: MIT
//
// Regression gate — the grok package must run on workerd without Buffer, process,
// or node:* imports. Reintroducing any Node-only primitive in src/ should fail.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ManagedSocket, SocketData, SocketFactory } from "@kuralle-syrinx/ws";

import { bytesToBase64, fromGrokRealtime } from "./from-grok-realtime.js";
import type { RealtimeEvent } from "@kuralle-syrinx/realtime";

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

async function collectEvents(
  events: AsyncIterable<RealtimeEvent>,
  max = 2,
): Promise<RealtimeEvent[]> {
  const out: RealtimeEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (out.length >= max) break;
  }
  return out;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("edge safety (grok)", () => {
  it("src/ contains no Buffer, process, or node:* imports", () => {
    const forbidden = [
      /\bfrom\s+["']node:/,
      /\brequire\s*\(\s*["']node:/,
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

  it("fromGrokRealtime round-trips audio via runtime-agnostic helpers", async () => {
    const mock = createEdgeMockHarness();
    const adapter = fromGrokRealtime({
      apiKey: "edge-test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=grok-voice-latest",
    });

    const eventsTask = collectEvents(adapter.events, 2);
    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    const providerPcm = new Uint8Array([100, 200, 300, 400]);
    mock.inject({ type: "response.created" });
    mock.inject({
      type: "response.output_audio.delta",
      delta: bytesToBase64(providerPcm),
    });

    const events = await eventsTask;
    expect(events[0]).toEqual({ type: "response_started" });
    expect(events[1]).toEqual({
      type: "audio",
      pcm16: providerPcm,
      sampleRateHz: 24_000,
    });

    await adapter.close();
  });
});
