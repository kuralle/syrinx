// SPDX-License-Identifier: MIT
//
// Integration: drives the real `runVoiceEdgeWebSocketConnection` + real
// `VoiceAgentSession` through the mixin, using a faithful fake Agent base (the
// capture-and-patch lifecycle the agents SDK applies) and a fake Connection.
// Only the leaf providers (stt/tts plugins, reasoner) are stubbed.

import { describe, it, expect, vi } from "vitest";
import type { Reasoner, VoicePlugin } from "@kuralle-syrinx/core";
import { withVoice } from "./with-voice.js";
import type { VoicePipeline } from "./build-session.js";

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

  // Tagged-template stand-in; unused by the voice path.
  sql(): unknown[] {
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

const cascadedPipeline = (): VoicePipeline<Record<string, unknown>> => ({
  kind: "cascaded",
  stt: () => ({ plugin: stubPlugin(), config: { model: "nova-3" } }),
  tts: () => ({ plugin: stubPlugin(), config: { voice_id: "v" } }),
});

// withVoice's base constraint is the real Agent surface; the fake satisfies the
// runtime contract but not its exact tagged-template `sql` type — cast for the test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asBase = (cls: unknown): any => cls;

const ctx = () => ({ request: new Request("https://agent.test/agents/voice/inst-1?sessionId=test-session") });

// --- Tests ---------------------------------------------------------------

describe("withVoice(Agent)", () => {
  it("starts a Syrinx voice session on connect and sends a `ready` frame", async () => {
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { pipeline: cascadedPipeline(), reasoner: () => stubReasoner() },
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
      { pipeline: cascadedPipeline(), reasoner: () => stubReasoner() },
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
      { pipeline: cascadedPipeline(), reasoner: () => stubReasoner() },
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
      { pipeline: cascadedPipeline() }, // no explicit reasoner
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
      { pipeline: cascadedPipeline() }, // no reasoner, no runtime
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
      { pipeline: cascadedPipeline(), reasoner: () => stubReasoner() },
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

  it("forceEndVoice closes the connection", () => {
    const VoiceAgent = withVoice<Record<string, unknown>, ReturnType<typeof asBase>>(
      asBase(FakeAgentBase),
      { pipeline: cascadedPipeline(), reasoner: () => stubReasoner() },
    );
    const agent = new VoiceAgent({});
    const conn = fakeConnection();
    agent.onConnect(conn, ctx());
    agent.forceEndVoice(conn);
    expect(conn.readyState).toBe(3);
  });
});
