// SPDX-License-Identifier: MIT
//
// Integration: drives the real `runVoiceEdgeWebSocketConnection` + real
// `VoiceAgentSession` through the mixin, using a faithful fake Agent base (the
// capture-and-patch lifecycle the agents SDK applies) and a fake Connection.
// Only the leaf providers (stt/tts plugins, reasoner) are stubbed.

import { describe, it, expect, vi } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type PipelineBus,
  type Reasoner,
  type UserAudioReceivedPacket,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import { encodePcm16ToMuLaw } from "@kuralle-syrinx/core/audio";
import type { RealtimeAdapter, RealtimeEvent } from "@kuralle-syrinx/realtime";
import {
  withVoice,
  type DelegateQueryContext,
  type DelegateResultContext,
  type RealtimeTurn,
  type ToolCallStartContext,
  type TurnContext,
} from "./with-voice.js";
import * as withVoiceModule from "./with-voice.js";
import type { VoicePipelineFields, VoicePipelineContext } from "./build-session.js";

/**
 * In-memory emulation of the DO-SQLite statements SqliteReasonerSessionStore issues,
 * shared across agent instances to simulate one Durable Object across evictions.
 */
function sqliteFake() {
  const history = new Map<string, Array<{ seq: number; role: string; content: string; tool_call_id: string | null }>>();
  const handles = new Map<string, string>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown[] => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("CREATE TABLE")) return [];
    if (query.includes("SELECT role, content, tool_call_id FROM syrinx_reasoner_history")) {
      return [...(history.get(String(values[0])) ?? [])].sort((a, b) => a.seq - b.seq);
    }
    if (query.includes("DELETE FROM syrinx_reasoner_history")) {
      history.delete(String(values[0]));
      return [];
    }
    if (query.includes("INSERT INTO syrinx_reasoner_history")) {
      const [sid, seq, role, content, toolCallId] = values;
      const rows = history.get(String(sid)) ?? [];
      rows.push({
        seq: Number(seq),
        role: String(role),
        content: String(content),
        tool_call_id: toolCallId === null ? null : String(toolCallId),
      });
      history.set(String(sid), rows);
      return [];
    }
    if (query.includes("SELECT handle FROM syrinx_resume_handle")) {
      const handle = handles.get(String(values[0]));
      return handle ? [{ handle }] : [];
    }
    if (query.includes("DELETE FROM syrinx_resume_handle")) {
      handles.delete(String(values[0]));
      return [];
    }
    if (query.includes("INSERT INTO syrinx_resume_handle")) {
      handles.set(String(values[0]), String(values[1]));
      return [];
    }
    return [];
  };
  return { sql, history, handles };
}

/** Controllable fake realtime front — `emit()` pushes provider events into the bridge. */
class FakeFront implements RealtimeAdapter {
  readonly caps = {
    inputSampleRateHz: 24_000,
    outputSampleRateHz: 24_000,
    supportsConcurrentToolAudio: true,
    supportsTruncate: true,
    emitsServerSpeechStarted: true,
  } as const;
  #queued: RealtimeEvent[] = [];
  #waiters: Array<(e: RealtimeEvent | null) => void> = [];
  #closed = false;
  readonly events: AsyncIterable<RealtimeEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<RealtimeEvent>> => {
        if (this.#queued.length) return { value: this.#queued.shift()!, done: false };
        if (this.#closed) return { value: undefined, done: true };
        const e = await new Promise<RealtimeEvent | null>((r) => this.#waiters.push(r));
        return e === null ? { value: undefined, done: true } : { value: e, done: false };
      },
    }),
  };
  async open(): Promise<void> {}
  sendAudio(): void {}
  cancelResponse(): void {}
  readonly injected: Array<{ toolId: string; text: string }> = [];
  injectToolResult(toolId: string, text: string): void {
    this.injected.push({ toolId, text });
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w(null);
  }
  emit(e: RealtimeEvent): void {
    const w = this.#waiters.shift();
    if (w) w(e);
    else this.#queued.push(e);
  }
}

// --- Fakes ---------------------------------------------------------------

class FakeAgentBase {
  name = "inst-1";
  env: Record<string, unknown>;
  runtime?: unknown;
  keepAliveCalls = 0;
  disposeCalls = 0;
  onConnectCalls = 0;
  onCloseCalls = 0;

  constructor(env: Record<string, unknown> = {}) {
    this.env = env;
  }

  async keepAlive(): Promise<() => void> {
    this.keepAliveCalls += 1;
    return () => {
      this.disposeCalls += 1;
    };
  }

  getConnections(): Iterable<unknown> {
    return [];
  }

  // Tagged-template stand-in; the durable-history path issues real statements
  // against it (subclasses can back it with an in-memory emulation).
  sql(_strings?: TemplateStringsArray, ..._values: unknown[]): unknown[] {
    return [];
  }

  onConnect(_connection: unknown, _ctx: unknown): void {
    this.onConnectCalls += 1;
  }
  onMessage(_connection: unknown, _message: unknown): void {}
  onClose(_connection: unknown, _code: number, _reason: string, _wasClean: boolean): void {
    this.onCloseCalls += 1;
  }
}

interface FakeConnection {
  id: string;
  readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  frames: Array<string | ArrayBuffer | ArrayBufferView>;
}

function fakeConnection(id = "conn-1"): FakeConnection {
  const frames: Array<string | ArrayBuffer | ArrayBufferView> = [];
  let open = true;
  return {
    id,
    get readyState() {
      return open ? 1 : 3;
    },
    send(data) {
      frames.push(data);
    },
    close() {
      open = false;
    },
    frames,
  };
}

const jsonFrames = (conn: FakeConnection): Array<Record<string, unknown>> =>
  conn.frames
    .filter((f): f is string => typeof f === "string")
    .map((f) => JSON.parse(f) as Record<string, unknown>);

const stubPlugin = (): VoicePlugin => ({ initialize: async () => {}, close: async () => {} });
const stubReasoner = (): Reasoner => ({
  // eslint-disable-next-line require-yield
  stream: async function* () {
    return;
  },
});

const cascadedPipeline = (): VoicePipelineFields<Record<string, unknown>> => ({
  stt: () => ({ plugin: stubPlugin(), config: { model: "nova-3" } }),
  tts: () => ({ plugin: stubPlugin(), config: { voice_id: "v" } }),
});

// withVoice's base constraint is the real Agent surface; the fake satisfies the
// runtime contract but not its exact tagged-template `sql` type — cast for the test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asBase = (cls: unknown): any => cls;

const ctx = () => ({ request: new Request("https://agent.test/agents/voice/inst-1?sessionId=test-session") });
const ctxForSession = (sessionId: string) => ({
  request: new Request(`https://agent.test/agents/voice/inst-1?sessionId=${encodeURIComponent(sessionId)}`),
});

// --- Tests ---------------------------------------------------------------

describe("withVoice(Agent)", () => {
  it("starts a Syrinx voice session on connect and sends a `ready` frame", async () => {
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { ...cascadedPipeline(), reasoner: () => stubReasoner() },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());

    await vi.waitFor(() => {
      expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true);
    });
    const ready = jsonFrames(conn).find((f) => f["type"] === "ready");
    expect(ready?.["sessionId"]).toBe("test-session");
  });

  it("chains the base onConnect and holds a keepAlive lease, released on close", async () => {
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { ...cascadedPipeline(), reasoner: () => stubReasoner() },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(agent.keepAliveCalls).toBe(1));
    expect(agent.onConnectCalls).toBe(1); // base hook still ran
    expect(agent.disposeCalls).toBe(0);

    agent.onClose(conn, 1000, "bye", true);
    expect(agent.onCloseCalls).toBe(1); // base hook still ran
    expect(agent.disposeCalls).toBe(1); // lease released
  });

  it("pumps inbound frames into the running session without throwing", async () => {
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { ...cascadedPipeline(), reasoner: () => stubReasoner() },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    // A ping after ready is handled as a no-op by the edge protocol.
    expect(() => agent.onMessage(conn, JSON.stringify({ type: "ping" }))).not.toThrow();
  });

  it("defaults the reasoner to the agent's kuralle runtime when none is supplied", async () => {
    class RuntimeAgent extends FakeAgentBase {
      override runtime = {
        run: () => ({
          events: (async function* () {
            return;
          })(),
        }),
      };
    }
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(RuntimeAgent),
      { ...cascadedPipeline() }, // no explicit reasoner
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => {
      expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true);
    });
  });

  it("reports an initialization error frame when a cascaded agent has no brain", async () => {
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { ...cascadedPipeline() }, // no reasoner, no runtime
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => {
      const err = jsonFrames(conn).find((f) => f["type"] === "error");
      expect(err).toBeDefined();
      expect(String(err?.["message"])).toMatch(/reasoner/);
    });
    expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(false);
  });

  it("gives each connection a distinct session id when no ?sessionId= is supplied", async () => {
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { ...cascadedPipeline(), reasoner: () => stubReasoner() },
    );
    const agent = new VoiceAgent({});
    const noQuery = () => ({ request: new Request("https://agent.test/agents/voice/inst-1") });
    const a = fakeConnection("a");
    const b = fakeConnection("b");

    agent.onConnect(a, noQuery());
    agent.onConnect(b, noQuery());

    const sid = async (c: FakeConnection): Promise<string> => {
      await vi.waitFor(() => expect(jsonFrames(c).some((f) => f["type"] === "ready")).toBe(true));
      return String(jsonFrames(c).find((f) => f["type"] === "ready")?.["sessionId"]);
    };
    const sidA = await sid(a);
    const sidB = await sid(b);

    expect(sidA).not.toBe(sidB); // not shared -> no cross-wiring
    expect(sidA).not.toBe("inst-1"); // not defaulted to the agent name
    expect(sidB).not.toBe("inst-1");
  });

  it("transport:\"twilio\" speaks Media Streams — a μ-law media frame reaches the engine", async () => {
    // Capture engine-ward audio so we can prove the Twilio runner decoded the μ-law
    // media event and pushed it onto the session bus (no edge-protocol error frame).
    const captured: UserAudioReceivedPacket[] = [];
    const capturingStt = (): VoicePlugin => ({
      initialize: async (bus: PipelineBus) => {
        bus.on<UserAudioReceivedPacket>("user.audio_received", (pkt) => { captured.push(pkt); });
      },
      close: async () => {},
    });
    const twilioPipeline: VoicePipelineFields<Record<string, unknown>> = {
      stt: () => ({ plugin: capturingStt(), config: { model: "nova-3" } }),
      tts: () => ({ plugin: stubPlugin(), config: { voice_id: "v" } }),
    };
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { transport: "twilio", ...twilioPipeline, reasoner: () => stubReasoner() },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());

    // Twilio handshake, then a non-silent μ-law 8 kHz frame (160 samples = 20ms).
    const tone = Int16Array.from({ length: 160 }, (_, i) => Math.round(8000 * Math.sin(i / 4)));
    const payload = Buffer.from(encodePcm16ToMuLaw(tone)).toString("base64");
    agent.onMessage(conn, JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    agent.onMessage(conn, JSON.stringify({
      event: "start",
      streamSid: "MZ1",
      start: { streamSid: "MZ1", callSid: "CA1", mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } },
    }));
    agent.onMessage(conn, JSON.stringify({ event: "media", streamSid: "MZ1", media: { payload } }));

    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));
    // Resampled 8 kHz → 16 kHz engine PCM: non-empty audio reached the engine.
    expect(captured[0]!.audio.byteLength).toBeGreaterThan(0);
    // No edge-protocol error frame (the Twilio runner accepted the handshake).
    expect(jsonFrames(conn).some((f) => f["type"] === "error")).toBe(false);
  });

  it("transport:\"telnyx\" speaks Media Streaming — a PCMU media frame reaches the engine", async () => {
    const captured: UserAudioReceivedPacket[] = [];
    const capturingStt = (): VoicePlugin => ({
      initialize: async (bus: PipelineBus) => {
        bus.on<UserAudioReceivedPacket>("user.audio_received", (pkt) => { captured.push(pkt); });
      },
      close: async () => {},
    });
    const telnyxPipeline: VoicePipelineFields<Record<string, unknown>> = {
      stt: () => ({ plugin: capturingStt(), config: { model: "nova-3" } }),
      tts: () => ({ plugin: stubPlugin(), config: { voice_id: "v" } }),
    };
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { transport: "telnyx", ...telnyxPipeline, reasoner: () => stubReasoner() },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());

    const tone = Int16Array.from({ length: 160 }, (_, i) => Math.round(8000 * Math.sin(i / 4)));
    const payload = Buffer.from(encodePcm16ToMuLaw(tone)).toString("base64");
    agent.onMessage(conn, JSON.stringify({ event: "connected", version: "1.0.0" }));
    agent.onMessage(conn, JSON.stringify({
      event: "start",
      stream_id: "stream-1",
      start: {
        stream_id: "stream-1",
        call_control_id: "v3:cc1",
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      },
    }));
    agent.onMessage(conn, JSON.stringify({ event: "media", stream_id: "stream-1", media: { payload } }));

    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));
    expect(captured[0]!.audio.byteLength).toBeGreaterThan(0);
    expect(captured[0]!.contextId).toBe("telnyx-v3:cc1");
    expect(jsonFrames(conn).some((f) => f["type"] === "error")).toBe(false);
  });

  it("fires onToolCallStart with the tool + the live connection when the delegate tool is invoked", async () => {
    const front = new FakeFront();
    const calls: ToolCallStartContext[] = [];
    const realtimePipeline: VoicePipelineFields<Record<string, unknown>> = {
      realtime: () => front,
      delegateToolName: "consult_knowledge",
    };
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        ...realtimePipeline,
        reasoner: () => stubReasoner(),
        onToolCallStart: (c) => { calls.push(c); },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    // The front model starts the turn, then invokes the delegate tool — the latency-mask moment.
    front.emit({ type: "response_started" });
    front.emit({ type: "tool_call", toolId: "t1", toolName: "consult_knowledge", args: { query: "fees" } });

    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]!.toolName).toBe("consult_knowledge");
    expect(calls[0]!.args).toEqual({ query: "fees" });
    expect(calls[0]!.sessionId).toBe("test-session");
    // The app gets the real connection — it can `connection.send(...)` a preamble/earcon trigger.
    expect(calls[0]!.connection).toBe(conn);
  });

  it("G2/WBS-1: fires onDelegateQuery/onDelegateResult around the reasoner run (SLIIT log-wrapper replacement)", async () => {
    const front = new FakeFront();
    const answeringReasoner = (): Reasoner => ({
      stream: async function* () {
        yield { type: "text-delta", text: "March 31." } as const;
        yield { type: "finish", reason: "stop", text: "March 31." } as const;
      },
    });
    const queries: DelegateQueryContext[] = [];
    const results: DelegateResultContext[] = [];
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        delegateToolName: "consult_knowledge",
        reasoner: () => answeringReasoner(),
        onDelegateQuery: (c) => { queries.push(c); },
        onDelegateResult: (c) => { results.push(c); },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    front.emit({ type: "tool_call", toolId: "t1", toolName: "consult_knowledge", args: { query: "exam deadline" } });

    await vi.waitFor(() => expect(results.length).toBeGreaterThan(0));
    expect(queries[0]).toMatchObject({
      query: "exam deadline",
      toolId: "t1",
      toolName: "consult_knowledge",
      sessionId: "test-session",
    });
    expect(queries[0]!.connection).toBe(conn);
    expect(results[0]).toMatchObject({
      query: "exam deadline",
      answer: "March 31.",
      grounded: false,
      toolId: "t1",
      toolName: "consult_knowledge",
      sessionId: "test-session",
    });
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(results[0]!.connection).toBe(conn);
  });

  it("routes post-result messages through the originating connection and resolved session", async () => {
    const fronts = new Map<string, FakeFront>();
    const results: DelegateResultContext[] = [];
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: (_env, pipelineCtx) => {
          const front = new FakeFront();
          fronts.set(pipelineCtx.sessionId, front);
          return front;
        },
        delegateToolName: "consult_knowledge",
        reasoner: () => ({
          stream: async function* () {
            yield { type: "finish", reason: "stop", text: "Answer" } as const;
          },
        }),
        sessionId: (request) => `resolved-${new URL(request.url).searchParams.get("sessionId") ?? "missing"}`,
        onDelegateResult: (result) => {
          results.push(result);
          result.connection.send(JSON.stringify({
            type: "app.delegate_result",
            sessionId: result.sessionId,
            answer: result.answer,
          }));
        },
      },
    );
    const agent = new VoiceAgent({});
    const connectionA = fakeConnection("connection-a");
    const connectionB = fakeConnection("connection-b");

    agent.onConnect(connectionA, ctxForSession("wire-a"));
    agent.onConnect(connectionB, ctxForSession("wire-b"));
    await vi.waitFor(() => {
      expect(jsonFrames(connectionA).some((frame) => frame["type"] === "ready")).toBe(true);
      expect(jsonFrames(connectionB).some((frame) => frame["type"] === "ready")).toBe(true);
    });
    expect(jsonFrames(connectionA).find((frame) => frame["type"] === "ready")?.["sessionId"]).toBe("resolved-wire-a");
    expect(jsonFrames(connectionB).find((frame) => frame["type"] === "ready")?.["sessionId"]).toBe("resolved-wire-b");

    fronts.get("resolved-wire-a")!.emit({ type: "response_started" });
    fronts.get("resolved-wire-a")!.emit({ type: "tool_call", toolId: "tool-a", toolName: "consult_knowledge", args: { query: "a" } });
    fronts.get("resolved-wire-b")!.emit({ type: "response_started" });
    fronts.get("resolved-wire-b")!.emit({ type: "tool_call", toolId: "tool-b", toolName: "consult_knowledge", args: { query: "b" } });

    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results.map((result) => ({ sessionId: result.sessionId, connection: result.connection.id }))).toEqual([
      { sessionId: "resolved-wire-a", connection: "connection-a" },
      { sessionId: "resolved-wire-b", connection: "connection-b" },
    ]);
    expect(jsonFrames(connectionA)).toContainEqual({ type: "app.delegate_result", sessionId: "resolved-wire-a", answer: "Answer" });
    expect(jsonFrames(connectionB)).toContainEqual({ type: "app.delegate_result", sessionId: "resolved-wire-b", answer: "Answer" });
  });

  it("G2/WBS-1: throwing onDelegateQuery/onDelegateResult never break the call", async () => {
    const front = new FakeFront();
    const answered: string[] = [];
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        delegateToolName: "consult_knowledge",
        reasoner: () => ({
          stream: async function* () {
            yield { type: "finish", reason: "stop", text: "ok" } as const;
          },
        }),
        onDelegateQuery: () => { throw new Error("query hook blew up"); },
        onDelegateResult: (c) => { answered.push(c.answer); throw new Error("result hook blew up"); },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    front.emit({ type: "tool_call", toolId: "t1", toolName: "consult_knowledge", args: { query: "x" } });

    await vi.waitFor(() => expect(answered.length).toBeGreaterThan(0));
    // The connection stays usable after both hooks threw.
    expect(() => agent.onMessage(conn, JSON.stringify({ type: "ping" }))).not.toThrow();
  });

  it("G1/WBS-2: realtime pipeline wraps the delegate answer in the envelope (default) with the configured render directive", async () => {
    const front = new FakeFront();
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        delegateToolName: "consult_knowledge",
        renderDirective: "translate_faithfully",
        reasoner: () => ({
          stream: async function* () {
            yield { type: "finish", reason: "stop", text: "The fee is 5000 rupees." } as const;
          },
        }),
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    front.emit({ type: "tool_call", toolId: "t1", toolName: "consult_knowledge", args: { query: "fees" } });

    await vi.waitFor(() => expect(front.injected.length).toBeGreaterThan(0));
    expect(JSON.parse(front.injected[0]!.text)).toEqual({
      response_text: "The fee is 5000 rupees.",
      require_repeat_verbatim: true,
      render: "translate_faithfully",
    });
  });

  it("a throwing onToolCallStart never breaks the call", async () => {
    const front = new FakeFront();
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        delegateToolName: "consult_knowledge",
        reasoner: () => stubReasoner(),
        onToolCallStart: () => { throw new Error("app hook blew up"); },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    expect(() => {
      front.emit({ type: "tool_call", toolId: "t1", toolName: "consult_knowledge", args: { query: "x" } });
    }).not.toThrow();
    // The connection stays usable (a ping after the throwing hook is still handled).
    await new Promise((r) => setTimeout(r, 10));
    expect(() => agent.onMessage(conn, JSON.stringify({ type: "ping" }))).not.toThrow();
  });

  it("G4/WBS-4: realtime transcript survives a simulated eviction — the next instance resumes with prior context", async () => {
    const db = sqliteFake();
    class DurableBase extends FakeAgentBase {
      override sql(strings?: TemplateStringsArray, ...values: unknown[]): unknown[] {
        return db.sql(strings!, ...values);
      }
    }
    const fronts: FakeFront[] = [];
    const seenResume: Array<VoicePipelineContext["resume"]> = [];
    const capturedMessages: Array<readonly unknown[]> = [];
    const makeAgentClass = () =>
      withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(asBase(DurableBase), {
        realtime: (_env: unknown, pipelineCtx: VoicePipelineContext) => {
          seenResume.push(pipelineCtx.resume);
          const front = new FakeFront();
          fronts.push(front);
          return front;
        },
        reasoner: () => ({
          stream: (turn) => {
            capturedMessages.push([...turn.messages]);
            return (async function* () {
              yield { type: "finish", reason: "stop", text: "ok" } as const;
            })();
          },
        }),
      });

    // First lifetime: one spoken exchange lands in the durable transcript.
    const FirstAgent = makeAgentClass();
    const first = new FirstAgent({});
    const firstConn = fakeConnection("c1");
    first.onConnect(firstConn, ctx());
    await vi.waitFor(() => expect(jsonFrames(firstConn).some((f) => f["type"] === "ready")).toBe(true));
    fronts[0]!.emit({ type: "response_started" });
    fronts[0]!.emit({ type: "transcript", role: "user", text: "What are the fees?", final: true });
    fronts[0]!.emit({ type: "transcript", role: "assistant", text: "Fees are 5000 rupees.", final: true });
    fronts[0]!.emit({ type: "response_done" });
    await vi.waitFor(() => expect(db.history.get("test-session")?.length).toBe(2));
    first.onClose(firstConn, 1000, "evicted", true);

    // Second lifetime (fresh class + instance = evicted DO, same SQLite).
    const SecondAgent = makeAgentClass();
    const second = new SecondAgent({});
    const secondConn = fakeConnection("c2");
    second.onConnect(secondConn, ctx());
    await vi.waitFor(() => expect(jsonFrames(secondConn).some((f) => f["type"] === "ready")).toBe(true));

    // The front factory sees the prior transcript via ctx.resume.
    expect(seenResume[1]?.history()).toEqual([
      { role: "user", content: "What are the fees?" },
      { role: "assistant", content: "Fees are 5000 rupees." },
    ]);

    // A delegate turn hands the reasoner the same prior context (re-seeded, R6).
    fronts[1]!.emit({ type: "response_started" });
    fronts[1]!.emit({ type: "tool_call", toolId: "t1", toolName: "consult_knowledge", args: { query: "deadlines?" } });
    await vi.waitFor(() => expect(capturedMessages.length).toBeGreaterThan(0));
    expect(capturedMessages[0]).toEqual([
      { role: "user", content: "What are the fees?" },
      { role: "assistant", content: "Fees are 5000 rupees." },
    ]);
  });

  it("G4/WBS-4: persists the latest native resume handle and exposes it on the next instance (Gemini passthrough, no replay)", async () => {
    const db = sqliteFake();
    class DurableBase extends FakeAgentBase {
      override sql(strings?: TemplateStringsArray, ...values: unknown[]): unknown[] {
        return db.sql(strings!, ...values);
      }
    }
    const fronts: FakeFront[] = [];
    const seenResume: Array<VoicePipelineContext["resume"]> = [];
    const makeAgentClass = () =>
      withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(asBase(DurableBase), {
        realtime: (_env: unknown, pipelineCtx: VoicePipelineContext) => {
          seenResume.push(pipelineCtx.resume);
          const front = new FakeFront();
          fronts.push(front);
          return front;
        },
        reasoner: () => stubReasoner(),
      });

    const FirstAgent = makeAgentClass();
    const first = new FirstAgent({});
    const firstConn = fakeConnection("c1");
    first.onConnect(firstConn, ctx());
    await vi.waitFor(() => expect(jsonFrames(firstConn).some((f) => f["type"] === "ready")).toBe(true));
    expect(seenResume[0]?.providerHandle).toBeUndefined();
    fronts[0]!.emit({ type: "resumption_handle", handle: "handle-1" });
    fronts[0]!.emit({ type: "resumption_handle", handle: "handle-2" });
    await vi.waitFor(() => expect(db.handles.get("test-session")).toBe("handle-2"));
    first.onClose(firstConn, 1000, "evicted", true);

    const SecondAgent = makeAgentClass();
    const second = new SecondAgent({});
    const secondConn = fakeConnection("c2");
    second.onConnect(secondConn, ctx());
    await vi.waitFor(() => expect(jsonFrames(secondConn).some((f) => f["type"] === "ready")).toBe(true));
    expect(seenResume[1]?.providerHandle).toBe("handle-2");
  });

  it("wires the realtime turn observer's bus subscriptions regardless of durableHistory (extracted from the durable branch)", async () => {
    // At HEAD the llm.done/eos.turn_complete subscriptions live inside
    // `if (durable && ...)`, so with durableHistory: false neither subscription is
    // ever created — VoiceAgentSession's own built-in "eos.turn_complete" handler
    // (voice-agent-session.ts) is the only one registered. Spying on the bus class's
    // own `on` method (not the with-voice module) sidesteps ESM same-module binding
    // limits and observes real subscription registration on the real session bus.
    const countEosSubscriptions = async (durableHistory: boolean): Promise<number> => {
      const front = new FakeFront();
      const onSpy = vi.spyOn(PipelineBusImpl.prototype, "on");
      const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
        asBase(FakeAgentBase),
        { realtime: () => front, reasoner: () => stubReasoner(), durableHistory },
      );
      const agent = new VoiceAgent({});
      const conn = fakeConnection();
      agent.onConnect(conn, ctx());
      await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));
      const count = onSpy.mock.calls.filter((call) => call[0] === "eos.turn_complete").length;
      onSpy.mockRestore();
      return count;
    };

    const withDurableHistory = await countEosSubscriptions(true);
    const withoutDurableHistory = await countEosSubscriptions(false);

    // More than VoiceAgentSession's own built-in subscription — the turn observer's
    // subscription is present too.
    expect(withoutDurableHistory).toBeGreaterThan(1);
    // And identical to the durableHistory: true case — proof the subscription no
    // longer depends on the persistence flag.
    expect(withoutDurableHistory).toBe(withDurableHistory);
  });

  it("observeRealtimeTurns pairs llm.done (assistant) with the eos.turn_complete (user) that follows it, once per turn", async () => {
    const bus = new PipelineBusImpl();
    const turns: RealtimeTurn[] = [];
    withVoiceModule.observeRealtimeTurns(bus, (turn) => turns.push(turn));
    void bus.start();

    // The bridge pushes llm.done BEFORE eos.turn_complete for the same contextId —
    // the assistant half must be buffered until the turn's eos.turn_complete arrives.
    bus.push(Route.Main, {
      kind: "llm.done",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "Fees are 5000 rupees.",
    });
    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "What are the fees?",
      transcripts: [],
    });

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]).toEqual({
      turnId: "turn-1",
      userText: "What are the fees?",
      assistantText: "Fees are 5000 rupees.",
    });
    bus.stop();
  });

  it("observeRealtimeTurns correlates llm.done/eos.turn_complete per contextId — two interleaved turns don't cross-wire their assistant halves", async () => {
    const bus = new PipelineBusImpl();
    const turns: RealtimeTurn[] = [];
    withVoiceModule.observeRealtimeTurns(bus, (turn) => turns.push(turn));
    void bus.start();

    // Both llm.done packets land before either turn's eos.turn_complete — a
    // correlation that keys on order rather than contextId would hand turn-1 the
    // wrong (or the last-seen) assistant text.
    bus.push(Route.Main, {
      kind: "llm.done",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "Answer one.",
    });
    bus.push(Route.Main, {
      kind: "llm.done",
      contextId: "turn-2",
      timestampMs: Date.now(),
      text: "Answer two.",
    });
    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "Question one?",
      transcripts: [],
    });
    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-2",
      timestampMs: Date.now(),
      text: "Question two?",
      transcripts: [],
    });
    // turn-3 has no llm.done of its own (e.g. the front answered with no delegate
    // consult in time) — its pairing must not pick up a stale assistant text.
    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-3",
      timestampMs: Date.now(),
      text: "Question three?",
      transcripts: [],
    });

    await vi.waitFor(() => expect(turns).toHaveLength(3));
    expect(turns[0]).toEqual({ turnId: "turn-1", userText: "Question one?", assistantText: "Answer one." });
    expect(turns[1]).toEqual({ turnId: "turn-2", userText: "Question two?", assistantText: "Answer two." });
    expect(turns[2]).toEqual({ turnId: "turn-3", userText: "Question three?" });
    bus.stop();
  });

  it("observeRealtimeTurns bounds the pendingAssistant map — interrupted turns evict oldest-first, not grow forever", async () => {
    // An interrupted turn is an llm.done whose eos.turn_complete never arrives, so its
    // buffered assistant half is never deleted. The map lives for the whole Durable
    // Object session, so unbounded growth is one orphan per interrupted turn.
    //
    // The map is closure-private, so eviction is asserted through behaviour: after
    // overflowing the cap with interrupted turns, the OLDEST entry must be gone while
    // the NEWEST survives. At HEAD nothing is evicted, so the oldest still carries its
    // assistant text and the first expectation below fails — that is the red gate.
    const CAP = 64;
    const bus = new PipelineBusImpl();
    const turns: RealtimeTurn[] = [];
    withVoiceModule.observeRealtimeTurns(bus, (turn) => turns.push(turn));
    void bus.start();

    // CAP + 1 interrupted turns: each gets an llm.done, none gets an eos.turn_complete.
    for (let i = 0; i < CAP + 1; i++) {
      bus.push(Route.Main, {
        kind: "llm.done",
        contextId: `orphan-${i}`,
        timestampMs: Date.now(),
        text: `Answer ${i}.`,
      });
    }
    // Nothing has completed a turn yet — an llm.done alone never reports a turn.
    await vi.waitFor(() => expect(turns).toHaveLength(0));

    // Now complete the oldest and the newest. Inserting orphan-64 pushed orphan-0 out.
    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "orphan-0",
      timestampMs: Date.now(),
      text: "Oldest question?",
      transcripts: [],
    });
    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: `orphan-${CAP}`,
      timestampMs: Date.now(),
      text: "Newest question?",
      transcripts: [],
    });

    await vi.waitFor(() => expect(turns).toHaveLength(2));
    // Evicted: the turn still commits, it just carries no stale assistant half.
    expect(turns[0]).toEqual({ turnId: "orphan-0", userText: "Oldest question?" });
    // Retained: eviction took the oldest, never the most recent.
    expect(turns[1]).toEqual({
      turnId: `orphan-${CAP}`,
      userText: "Newest question?",
      assistantText: `Answer ${CAP}.`,
    });
    bus.stop();
  });

  it("commits the observed turn user-then-assistant when durable history is on", async () => {
    const db = sqliteFake();
    class DurableBase extends FakeAgentBase {
      override sql(strings?: TemplateStringsArray, ...values: unknown[]): unknown[] {
        return db.sql(strings!, ...values);
      }
    }
    const front = new FakeFront();
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(DurableBase),
      { realtime: () => front, reasoner: () => stubReasoner() },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    front.emit({ type: "transcript", role: "user", text: "What are the fees?", final: true });
    front.emit({ type: "transcript", role: "assistant", text: "Fees are 5000 rupees.", final: true });
    front.emit({ type: "response_done" });

    await vi.waitFor(() => expect(db.history.get("test-session")?.length).toBe(2));
    const rows = [...db.history.get("test-session")!].sort((a, b) => a.seq - b.seq);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("G4/WBS-4: cascaded pipeline re-seeds the ReasoningBridge from durable history after eviction", async () => {
    const db = sqliteFake();
    class DurableBase extends FakeAgentBase {
      override sql(strings?: TemplateStringsArray, ...values: unknown[]): unknown[] {
        return db.sql(strings!, ...values);
      }
    }
    const capturedMessages: Array<readonly unknown[]> = [];
    const makeAgentClass = (reply: string) =>
      withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(asBase(DurableBase), {
        ...cascadedPipeline(),
        reasoner: () => ({
          stream: (turn) => {
            capturedMessages.push([...turn.messages]);
            return (async function* () {
              yield { type: "text-delta", text: reply } as const;
              yield { type: "finish", reason: "stop", text: reply } as const;
            })();
          },
        }),
      });

    const FirstAgent = makeAgentClass("Answer one.");
    const first = new FirstAgent({});
    const firstConn = fakeConnection("c1");
    first.onConnect(firstConn, ctx());
    await vi.waitFor(() => expect(jsonFrames(firstConn).some((f) => f["type"] === "ready")).toBe(true));
    first.onMessage(firstConn, JSON.stringify({ type: "text", text: "First question", contextId: "turn-1" }));
    await vi.waitFor(() => expect(db.history.get("test-session")?.length).toBe(2));
    first.onClose(firstConn, 1000, "evicted", true);

    const SecondAgent = makeAgentClass("Answer two.");
    const second = new SecondAgent({});
    const secondConn = fakeConnection("c2");
    second.onConnect(secondConn, ctx());
    await vi.waitFor(() => expect(jsonFrames(secondConn).some((f) => f["type"] === "ready")).toBe(true));
    second.onMessage(secondConn, JSON.stringify({ type: "text", text: "Second question", contextId: "turn-2" }));
    await vi.waitFor(() => expect(capturedMessages.length).toBe(2));
    expect(capturedMessages[1]).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Answer one." },
    ]);
  });

  it("fires onTurn once with consulted: false for a turn the front answers with no delegate call", async () => {
    const front = new FakeFront();
    const turns: TurnContext[] = [];
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        delegateToolName: "consult_knowledge",
        reasoner: () => stubReasoner(),
        onTurn: (c) => { turns.push(c); },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    front.emit({ type: "transcript", role: "user", text: "What time is it?", final: true });
    front.emit({ type: "transcript", role: "assistant", text: "It's 5pm.", final: true });
    front.emit({ type: "response_done" });

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]).toMatchObject({
      sessionId: "test-session",
      userText: "What time is it?",
      assistantText: "It's 5pm.",
      consulted: false,
    });
    expect(typeof turns[0]!.turnId).toBe("string");
    expect(typeof turns[0]!.ts).toBe("number");
  });

  it("fires onTurn once with consulted: true for a turn with a delegate call, and onDelegateResult still fires", async () => {
    const front = new FakeFront();
    const turns: TurnContext[] = [];
    const results: DelegateResultContext[] = [];
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        delegateToolName: "consult_knowledge",
        reasoner: () => ({
          stream: async function* () {
            yield { type: "finish", reason: "stop", text: "5000 rupees." } as const;
          },
        }),
        onDelegateResult: (c) => { results.push(c); },
        onTurn: (c) => { turns.push(c); },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    front.emit({ type: "tool_call", toolId: "t1", toolName: "consult_knowledge", args: { query: "fees" } });
    // The front only has an answer to speak once the delegate has returned it (G1:
    // `require_repeat_verbatim`) — wait for that real dependency, same as the G1/G2 tests
    // above, instead of firing the assistant's final transcript unconditionally.
    await vi.waitFor(() => expect(results).toHaveLength(1));
    front.emit({ type: "transcript", role: "user", text: "What are the fees?", final: true });
    front.emit({ type: "transcript", role: "assistant", text: "5000 rupees.", final: true });
    front.emit({ type: "response_done" });

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(results).toHaveLength(1); // onDelegateResult is additive, not replaced by onTurn
    expect(turns[0]).toMatchObject({
      sessionId: "test-session",
      userText: "What are the fees?",
      assistantText: "5000 rupees.",
      consulted: true,
    });
    expect(turns[0]!.turnId).toBe(results[0]!.turnId);
  });

  it("proves the ordering onTurn's consulted flag depends on: delegate_result is recorded before the turn commits", async () => {
    // `dispatchDelegate` in realtime-bridge.ts explicitly runs the reasoner OFF the serial
    // event pump (so barge-in stays responsive during the "thinking gap") — the pump does NOT
    // await the delegate before draining the next adapter event. So the pump alone gives no
    // ordering guarantee: an earlier version of this test fired tool_call and the assistant's
    // final transcript back-to-back with no wait, and observed onTurn fire with consulted:
    // false BEFORE delegate_result — i.e. the hazard the spec warns about, reproduced.
    //
    // The real guarantee is a provider-protocol one, not a pump one: a real front only has an
    // answer to VOICE once it has received the injected tool result (G1 envelope,
    // `require_repeat_verbatim`), and injection happens synchronously right after delegate.result
    // is pushed (realtime-bridge.ts `runDelegate`, the `bus.push(delegateResult)` /
    // `injectToolResult` pair). A provider cannot finalize the assistant transcript for a
    // delegate-answered turn before it has that answer to repeat. This test simulates that real
    // dependency (wait for the delegate to resolve before the turn's assistant transcript can
    // exist) rather than assuming pump ordering, and the resulting order proves consulted reads
    // correctly under it.
    const front = new FakeFront();
    const order: string[] = [];
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        delegateToolName: "consult_knowledge",
        reasoner: () => ({
          stream: async function* () {
            yield { type: "finish", reason: "stop", text: "5000 rupees." } as const;
          },
        }),
        onDelegateResult: () => { order.push("delegate_result"); },
        onTurn: (c) => { order.push(`onTurn:${c.consulted}`); },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    front.emit({ type: "tool_call", toolId: "t1", toolName: "consult_knowledge", args: { query: "fees" } });
    await vi.waitFor(() => expect(order).toContain("delegate_result"));
    front.emit({ type: "transcript", role: "user", text: "What are the fees?", final: true });
    front.emit({ type: "transcript", role: "assistant", text: "5000 rupees.", final: true });
    front.emit({ type: "response_done" });

    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual(["delegate_result", "onTurn:true"]);
  });

  it("keeps consulted: true when the turn commits before delegate_result arrives (NON_BLOCKING)", async () => {
    // A NON_BLOCKING tool call (42da625, Gemini Live) lets the front keep talking and commit
    // the turn WITHOUT waiting for the reasoner's answer — the inverse of the ordering the test
    // above relies on. delegate_result arrives strictly after this turn's eos.turn_complete.
    const front = new FakeFront();
    const turns: TurnContext[] = [];
    const results: DelegateResultContext[] = [];
    let releaseReasoner: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseReasoner = resolve; });
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        delegateToolName: "consult_knowledge",
        reasoner: () => ({
          stream: async function* () {
            await gate;
            yield { type: "finish", reason: "stop", text: "5000 rupees." } as const;
          },
        }),
        onDelegateResult: (c) => { results.push(c); },
        onTurn: (c) => { turns.push(c); },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    front.emit({ type: "tool_call", toolId: "t1", toolName: "consult_knowledge", args: { query: "fees" } });
    front.emit({ type: "transcript", role: "user", text: "What are the fees?", final: true });
    front.emit({ type: "transcript", role: "assistant", text: "One moment.", final: true });
    front.emit({ type: "response_done" });

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    // The turn committed before the reasoner resolved — the precondition for the hazard.
    expect(results).toHaveLength(0);
    expect(turns[0]).toMatchObject({ consulted: true });

    releaseReasoner();
    await vi.waitFor(() => expect(results).toHaveLength(1));
  });

  it("onTurn fires when durableHistory: false", async () => {
    const front = new FakeFront();
    const turns: TurnContext[] = [];
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        reasoner: () => stubReasoner(),
        durableHistory: false,
        onTurn: (c) => { turns.push(c); },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    front.emit({ type: "response_started" });
    front.emit({ type: "transcript", role: "user", text: "Hello?", final: true });
    front.emit({ type: "transcript", role: "assistant", text: "Hi there.", final: true });
    front.emit({ type: "response_done" });

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]).toMatchObject({ userText: "Hello?", assistantText: "Hi there.", consulted: false });
  });

  it("a throwing onTurn, and one that rejects, neither break the call nor suppress the next turn's onTurn", async () => {
    const front = new FakeFront();
    const turns: TurnContext[] = [];
    let call = 0;
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      {
        realtime: () => front,
        reasoner: () => stubReasoner(),
        onTurn: (c) => {
          call += 1;
          turns.push(c);
          if (call === 1) throw new Error("onTurn hook blew up synchronously");
          if (call === 2) return Promise.reject(new Error("onTurn hook rejected"));
          return undefined;
        },
      },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();

    agent.onConnect(conn, ctx());
    await vi.waitFor(() => expect(jsonFrames(conn).some((f) => f["type"] === "ready")).toBe(true));

    const speakTurn = (user: string, assistant: string): void => {
      front.emit({ type: "response_started" });
      front.emit({ type: "transcript", role: "user", text: user, final: true });
      front.emit({ type: "transcript", role: "assistant", text: assistant, final: true });
      front.emit({ type: "response_done" });
    };

    expect(() => speakTurn("Turn one?", "Answer one.")).not.toThrow();
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(() => speakTurn("Turn two?", "Answer two.")).not.toThrow();
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    speakTurn("Turn three?", "Answer three.");
    await vi.waitFor(() => expect(turns).toHaveLength(3));

    expect(turns.map((t) => t.userText)).toEqual(["Turn one?", "Turn two?", "Turn three?"]);
    // The connection stays usable after both a throw and a rejection.
    expect(() => agent.onMessage(conn, JSON.stringify({ type: "ping" }))).not.toThrow();
  });

  it("createConsultedTurnTracker bounds recorded turn ids at cap — the oldest is evicted, not O(N)", () => {
    const CAP = 64;
    const tracker = withVoiceModule.createConsultedTurnTracker(CAP);

    // CAP + 1 recorded turns, none consumed yet — the newest insertion must evict the oldest.
    for (let i = 0; i <= CAP; i++) tracker.record(`turn-${i}`);

    // Evicted: consume() reports false (and cannot double-report on a repeat call).
    expect(tracker.consume("turn-0")).toBe(false);
    expect(tracker.consume("turn-0")).toBe(false);
    // Retained: eviction took the oldest, never the most recent.
    expect(tracker.consume(`turn-${CAP}`)).toBe(true);
    // consume() clears on read — a second consume of the same id reports false.
    expect(tracker.consume(`turn-${CAP}`)).toBe(false);
  });

  it("forceEndVoice closes the connection", () => {
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { ...cascadedPipeline(), reasoner: () => stubReasoner() },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();
    agent.onConnect(conn, ctx());
    agent.forceEndVoice(conn);
    expect(conn.readyState).toBe(3);
  });
});
