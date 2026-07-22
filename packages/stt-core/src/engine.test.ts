// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { Route } from "@kuralle-syrinx/core";
import type { SocketData } from "@kuralle-syrinx/ws";
import { createSttEngine } from "./engine.js";
import type { SttEvent, SttWireProtocol, Transport } from "./types.js";

class FakeProtocol implements SttWireProtocol {
  ready = true;
  finalized: string[] = [];
  closed = false;

  isReady(): boolean {
    return this.ready;
  }

  encodeFinalize(contextId: string): SocketData[] {
    this.finalized.push(contextId);
    return [JSON.stringify({ op: "finalize", contextId })];
  }

  encodeClose(): SocketData[] {
    this.closed = true;
    return [JSON.stringify({ op: "close" })];
  }

  decode(data: SocketData): SttEvent[] {
    if (typeof data !== "string") return [];
    const m = JSON.parse(data) as {
      t?: string;
      text?: string;
      contextId?: string;
      confidence?: number;
      audioSeconds?: number;
      speechFinal?: boolean;
      msg?: string;
    };
    switch (m.t) {
      case "interim":
        return [
          {
            type: "interim",
            contextId: m.contextId ?? "",
            text: m.text ?? "",
          },
        ];
      case "final":
        return [
          {
            type: "final",
            contextId: m.contextId ?? "",
            text: m.text ?? "",
            confidence: m.confidence,
            audioSeconds: m.audioSeconds,
            speechFinal: m.speechFinal,
          },
        ];
      case "err":
        return [{ type: "error", contextId: m.contextId, error: new Error(m.msg ?? "err") }];
      case "boom":
        throw new Error("decode failure");
      default:
        return [];
    }
  }
}

function harness(opts: { emitEosOnFinal?: boolean; protocol?: FakeProtocol } = {}) {
  const sent: SocketData[] = [];
  const pushed: Array<{ route: Route; packet: Record<string, unknown> }> = [];
  let transportReady = true;
  const protocol = opts.protocol ?? new FakeProtocol();
  const transport: Transport = {
    ensureReady: async () => {},
    send: (frame) => {
      sent.push(frame);
    },
    close: async () => {},
    get isReady() {
      return transportReady;
    },
  };
  const engine = createSttEngine({
    protocol,
    transport,
    sink: { push: (route, packet) => pushed.push({ route, packet: packet as Record<string, unknown> }) },
    provider: { name: "fake", model: "stt" },
    emitEosOnFinal: opts.emitEosOnFinal ?? true,
    language: "en",
    now: () => 1000,
  });
  const byKind = (kind: string) => pushed.filter((p) => p.packet["kind"] === kind).map((p) => p.packet);
  return {
    engine,
    sent,
    protocol,
    setTransportReady: (v: boolean) => {
      transportReady = v;
    },
    interim: () => byKind("stt.interim"),
    results: () => byKind("stt.result"),
    usage: () => byKind("usage.recorded"),
    eos: () => byKind("eos.turn_complete"),
    errors: () => byKind("stt.error"),
  };
}

describe("SttEngine", () => {
  it("emits stt.interim for an interim SttEvent", async () => {
    const h = harness();
    await h.engine.onAudio(new Uint8Array(4), "ctx-1");
    h.engine.onMessage(JSON.stringify({ t: "interim", text: "hello", contextId: "ctx-1" }), false);
    expect(h.interim()).toEqual([
      expect.objectContaining({
        kind: "stt.interim",
        contextId: "ctx-1",
        text: "hello",
        timestampMs: 1000,
      }),
    ]);
  });

  it("emits stt.result for a final SttEvent", async () => {
    const h = harness();
    await h.engine.onAudio(new Uint8Array(4), "ctx-2");
    h.engine.onMessage(
      JSON.stringify({ t: "final", text: "hello world", contextId: "ctx-2", confidence: 0.9 }),
      false,
    );
    expect(h.results()).toEqual([
      expect.objectContaining({
        kind: "stt.result",
        contextId: "ctx-2",
        text: "hello world",
        confidence: 0.9,
        language: "en",
        provider: expect.objectContaining({ name: "fake", model: "stt" }),
      }),
    ]);
  });

  it("emits usage.recorded with delta-billing across multi-segment finals (no double-count)", async () => {
    const h = harness({ emitEosOnFinal: false });
    await h.engine.onAudio(new Uint8Array(4), "ctx-bill");

    h.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "seg one",
        contextId: "ctx-bill",
        audioSeconds: 1.2,
      }),
      false,
    );
    h.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "seg two",
        contextId: "ctx-bill",
        audioSeconds: 2.0,
      }),
      false,
    );
    // Repeat the same cumulative duration — must not bill again.
    h.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "seg two again",
        contextId: "ctx-bill",
        audioSeconds: 2.0,
      }),
      false,
    );

    expect(h.usage()).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "ctx-bill",
        stage: "stt",
        provider: "fake",
        model: "stt",
        audioSeconds: 1.2,
      }),
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "ctx-bill",
        stage: "stt",
        provider: "fake",
        model: "stt",
        audioSeconds: 0.8,
      }),
    ]);
  });

  it("stt.finalize triggers encodeFinalize", async () => {
    const h = harness();
    await h.engine.onAudio(new Uint8Array(2), "ctx-fin");
    await h.engine.onFinalize("ctx-fin");
    expect(h.protocol.finalized).toEqual(["ctx-fin"]);
    expect(h.sent).toContainEqual(JSON.stringify({ op: "finalize", contextId: "ctx-fin" }));
  });

  it("emitEosOnFinal gates eos.turn_complete", async () => {
    const gated = harness({ emitEosOnFinal: false });
    gated.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "done",
        contextId: "ctx-eos",
        speechFinal: true,
      }),
      false,
    );
    expect(gated.eos()).toHaveLength(0);
    expect(gated.results()).toHaveLength(1);

    const open = harness({ emitEosOnFinal: true });
    open.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "done",
        contextId: "ctx-eos",
        speechFinal: true,
      }),
      false,
    );
    expect(open.eos()).toEqual([
      expect.objectContaining({
        kind: "eos.turn_complete",
        contextId: "ctx-eos",
        text: "done",
      }),
    ]);

    // speechFinal false must not emit eos even when emitEosOnFinal is true
    const partial = harness({ emitEosOnFinal: true });
    partial.engine.onMessage(
      JSON.stringify({
        t: "final",
        text: "partial final",
        contextId: "ctx-eos2",
        speechFinal: false,
      }),
      false,
    );
    expect(partial.eos()).toHaveLength(0);
  });

  it("buffers outbound audio until the protocol is ready, then flushes it in order", async () => {
    const protocol = new FakeProtocol();
    protocol.ready = false;
    const h = harness({ protocol });
    // Pre-handshake audio is BUFFERED (accepted), not dropped, and not sent yet.
    const ok = await h.engine.onAudio(new Uint8Array(8), "ctx-wait");
    expect(ok).toBe(true);
    expect(h.sent).toHaveLength(0);
    // Once ready, the next audio flushes the buffered frame first, then sends the current one.
    protocol.ready = true;
    const ok2 = await h.engine.onAudio(new Uint8Array(8), "ctx-wait");
    expect(ok2).toBe(true);
    expect(h.sent).toHaveLength(2);
  });

  it("maps decode errors to stt.error", () => {
    const h = harness();
    h.engine.onMessage(JSON.stringify({ t: "boom" }), false);
    expect(h.errors()).toEqual([
      expect.objectContaining({
        kind: "stt.error",
        cause: expect.objectContaining({ message: "decode failure" }),
      }),
    ]);
  });
});
