// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { Route, type AudioFormat } from "@kuralle-syrinx/core";
import type { SocketData } from "@kuralle-syrinx/ws";
import { createTtsEngine } from "./engine.js";
import { attributionKey, type AttributionKey, type TimerHandle, type TimerPort, type Transport, type WireEvent, type WireProtocol } from "./types.js";

const FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1 };
const SESSION = attributionKey("session");

class FakeTimer implements TimerPort {
  private readonly timers = new Map<number, () => void>();
  private next = 0;
  set(_ms: number, fn: () => void): TimerHandle {
    const handle = this.next++;
    this.timers.set(handle, fn);
    return handle;
  }
  clear(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }
  fire(): void {
    for (const [handle, fn] of [...this.timers]) {
      this.timers.delete(handle);
      fn();
    }
  }
}

/** grok-shape: one constant key per session. */
class SingleProtocol implements WireProtocol {
  attributionFor(contextId: string) {
    return { key: SESSION, contextId };
  }
  encodeText(_key: AttributionKey, text: string): SocketData[] {
    return [JSON.stringify({ op: "text", text })];
  }
  encodeFinish(): SocketData[] {
    return [JSON.stringify({ op: "finish" })];
  }
  encodeCancel(): SocketData[] {
    return [JSON.stringify({ op: "clear" })];
  }
  encodeClose(): SocketData[] {
    return [];
  }
  decode(data: SocketData): WireEvent[] {
    return decodeTestFrame(data, SESSION);
  }
}

/** epsilon-shape: per-request key `${ctx}:${seq}`, refcount-driven end (no finish frame). */
class MultiplexProtocol implements WireProtocol {
  private readonly seq = new Map<string, number>();
  attributionFor(contextId: string) {
    const n = this.seq.get(contextId) ?? 0;
    this.seq.set(contextId, n + 1);
    return { key: attributionKey(`${contextId}:${n}`), contextId };
  }
  encodeText(key: AttributionKey, text: string): SocketData[] {
    return [JSON.stringify({ op: "speak", key, text })];
  }
  encodeFinish(): SocketData[] {
    return [];
  }
  encodeCancel(key: AttributionKey): SocketData[] {
    return [JSON.stringify({ op: "cancel", key })];
  }
  encodeClose(): SocketData[] {
    return [JSON.stringify({ op: "eos" })];
  }
  decode(data: SocketData): WireEvent[] {
    return decodeTestFrame(data, null);
  }
}

function decodeTestFrame(data: SocketData, fixedKey: AttributionKey | null): WireEvent[] {
  const m = JSON.parse(data as string) as { t?: string; key?: string; pcm?: number[]; msg?: string };
  const key = (m.key !== undefined ? attributionKey(m.key) : fixedKey) ?? SESSION;
  switch (m.t) {
    case "audio":
      return [{ type: "audio", key, pcm: Uint8Array.from(m.pcm ?? []) }];
    case "done":
      return [{ type: "utterance_end", key }];
    case "end":
      return [{ type: "context_end", key }];
    case "err":
      return [{ type: "error", key: m.key !== undefined ? key : null, error: new Error(m.msg ?? "err") }];
    case "boom":
      throw new Error("decode failure");
    default:
      return [];
  }
}

function harness(protocol: WireProtocol, finishTimeoutMs = 2000, opts: { sendThrows?: boolean } = {}) {
  const sent: SocketData[] = [];
  const pushed: Array<{ route: Route; packet: Record<string, unknown> }> = [];
  const timer = new FakeTimer();
  const transport: Transport = {
    ensureReady: async () => {},
    send: (frame) => {
      if (opts.sendThrows) throw new Error("WebSocket is not open");
      sent.push(frame);
    },
    close: async () => {},
  };
  const engine = createTtsEngine({
    protocol,
    transport,
    sink: { push: (route, packet) => pushed.push({ route, packet: packet as Record<string, unknown> }) },
    format: FORMAT,
    sampleRateHz: 24000,
    provider: { name: "fake", model: "m" },
    finishTimeoutMs,
    metricPrefix: "tts.fake",
    timer,
    now: () => 1000,
  });
  const byKind = (kind: string) => pushed.filter((p) => p.packet["kind"] === kind).map((p) => p.packet);
  return { engine, sent, pushed, timer, audio: () => byKind("tts.audio"), ends: () => byKind("tts.end"), errors: () => byKind("tts.error"), metrics: () => byKind("metric.conversation") };
}

describe("TtsEngine — single-context (grok-shape)", () => {
  it("carries an odd trailing byte across frames, then emits aligned PCM and ends on utterance_end", async () => {
    const h = harness(new SingleProtocol());
    await h.engine.onText("hello", "ctx1");
    expect(h.sent).toEqual([JSON.stringify({ op: "text", text: "hello" })]);

    h.engine.onMessage(JSON.stringify({ t: "audio", key: "session", pcm: [1] }), false);
    expect(h.audio()).toHaveLength(0); // 1 byte → odd, fully carried, nothing aligned yet

    h.engine.onMessage(JSON.stringify({ t: "audio", key: "session", pcm: [2, 3] }), false);
    expect(h.audio()).toHaveLength(1); // [1] + [2,3] = [1,2,3] → emit [1,2], carry [3]
    expect([...(h.audio()[0]!["audio"] as Uint8Array)]).toEqual([1, 2]);

    h.engine.onMessage(JSON.stringify({ t: "audio", key: "session", pcm: [4] }), false);
    expect(h.audio()).toHaveLength(2); // [3] + [4] = [3,4] → emit [3,4]
    expect([...(h.audio()[1]!["audio"] as Uint8Array)]).toEqual([3, 4]);

    await h.engine.onDone("ctx1");
    expect(h.sent).toContainEqual(JSON.stringify({ op: "finish" }));
    expect(h.ends()).toHaveLength(0); // still streaming
    h.engine.onMessage(JSON.stringify({ t: "done", key: "session" }), false);
    expect(h.ends()).toHaveLength(1);
  });

  it("emits tts.end immediately on a provider context_end, with no prior tts.done", async () => {
    const h = harness(new SingleProtocol());
    await h.engine.onText("a", "ctxCE");
    h.engine.onMessage(JSON.stringify({ t: "end", key: "session" }), false);
    expect(h.ends()).toHaveLength(1); // single-stream providers end on the provider's own done signal
  });

  it("drops audio after interrupt and sends the cancel frame", async () => {
    const h = harness(new SingleProtocol());
    await h.engine.onText("a", "ctxC");
    await h.engine.onInterrupt();
    expect(h.sent).toContainEqual(JSON.stringify({ op: "clear" }));
    h.engine.onMessage(JSON.stringify({ t: "audio", key: "session", pcm: [1, 2] }), false);
    expect(h.audio()).toHaveLength(0);
  });
});

describe("TtsEngine — multiplex (epsilon-shape)", () => {
  it("emits tts.end only after every per-request key for a context completes", async () => {
    const h = harness(new MultiplexProtocol());
    await h.engine.onText("a", "ctxM"); // ctxM:0
    await h.engine.onText("b", "ctxM"); // ctxM:1
    expect(h.sent).toHaveLength(2);

    await h.engine.onDone("ctxM"); // no finish frame; both requests still active
    expect(h.ends()).toHaveLength(0);
    h.engine.onMessage(JSON.stringify({ t: "done", key: "ctxM:0" }), false);
    expect(h.ends()).toHaveLength(0); // one still streaming
    h.engine.onMessage(JSON.stringify({ t: "done", key: "ctxM:1" }), false);
    expect(h.ends()).toHaveLength(1); // refcount hit zero
  });

  it("attributes audio per request key independently", async () => {
    const h = harness(new MultiplexProtocol());
    await h.engine.onText("a", "ctxM"); // ctxM:0
    await h.engine.onText("b", "ctxM"); // ctxM:1
    h.engine.onMessage(JSON.stringify({ t: "audio", key: "ctxM:0", pcm: [1, 2] }), false);
    h.engine.onMessage(JSON.stringify({ t: "audio", key: "ctxM:1", pcm: [3, 4] }), false);
    const audio = h.audio();
    expect(audio).toHaveLength(2);
    expect(audio.every((p) => p["contextId"] === "ctxM")).toBe(true);
  });
});

describe("TtsEngine — fallbacks and failures", () => {
  it("fires the finish-timeout: emits a metric and tts.end when the provider never reports done", async () => {
    const h = harness(new SingleProtocol(), 2000);
    await h.engine.onText("a", "ctxD");
    await h.engine.onDone("ctxD");
    expect(h.ends()).toHaveLength(0);
    h.timer.fire();
    expect(h.ends()).toHaveLength(1);
    expect(h.metrics().some((m) => m["name"] === "tts.fake.finish_timeout")).toBe(true);
  });

  it("maps a provider error frame to a categorized tts.error", async () => {
    const h = harness(new SingleProtocol());
    await h.engine.onText("a", "ctxE");
    h.engine.onMessage(JSON.stringify({ t: "err", key: "session", msg: "provider boom" }), false);
    const errors = h.errors();
    expect(errors).toHaveLength(1);
    expect((errors[0]!["cause"] as Error).message).toBe("provider boom");
    expect(typeof errors[0]!["isRecoverable"]).toBe("boolean");
  });

  it("treats a decode throw as fatal and fails all active contexts", async () => {
    const h = harness(new SingleProtocol());
    await h.engine.onText("a", "ctxF");
    h.engine.onMessage(JSON.stringify({ t: "boom" }), false);
    expect(h.errors().some((e) => e["contextId"] === "ctxF")).toBe(true);
  });

  it("emits tts.error and does not leave the context active when a send fails", async () => {
    const h = harness(new SingleProtocol(), 2000, { sendThrows: true });
    await h.engine.onText("a", "ctxSend");
    expect(h.errors().some((e) => e["contextId"] === "ctxSend")).toBe(true); // send failure → typed error
    await h.engine.onDone("ctxSend");
    expect(h.ends().some((e) => e["contextId"] === "ctxSend")).toBe(true); // context drained, turn ends (no hang)
  });

  it("fails active contexts on connection loss", async () => {
    const h = harness(new MultiplexProtocol());
    await h.engine.onText("a", "ctxG");
    h.engine.onConnectionLost(new Error("dropped"));
    expect(h.errors().some((e) => e["contextId"] === "ctxG")).toBe(true);
  });
});
