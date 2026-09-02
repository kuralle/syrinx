// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { Route, VoiceAgentSession } from "@kuralle-syrinx/core";
import { createVoiceWebSocketServer } from "./index.js";
import {
  InMemorySessionStore,
  type ManagedSession,
  type SessionStore,
} from "./session-store.js";
import { TurnMetricsTracker } from "./turn-metrics.js";
import {
  startLoopbackTransportServer,
  openBrowserClientAndReadReady,
  setupTransportTestCleanup,
  waitForCondition,
} from "./test-helpers.js";

setupTransportTestCleanup();

function createManagedSession(id: string): ManagedSession {
  return {
    id,
    session: new VoiceAgentSession({ plugins: {} }),
    currentContextId: "turn-test",
    contextSampleRates: new Map(),
    inputSequence: { lastSequence: null },
    turnMetricsTurns: new Map(),
    closeTimer: null,
    connectionCount: 1,
  };
}

describe("InMemorySessionStore", () => {
  it("leases a new session when none exists", async () => {
    const store = new InMemorySessionStore();
    const create = vi.fn(async () => createManagedSession("session-a"));

    const leased = await store.lease("session-a", create);

    expect(create).toHaveBeenCalledTimes(1);
    expect(leased.resumed).toBe(false);
    expect(leased.managed.id).toBe("session-a");
    expect(await store.get("session-a")).toBe(leased.managed);
  });

  it("resumes an existing session within the retention window", async () => {
    const store = new InMemorySessionStore();
    const create = vi.fn(async () => createManagedSession("session-a"));
    const first = await store.lease("session-a", create);
    first.managed.connectionCount = 0;
    await store.release("session-a", 200);

    const second = await store.lease("session-a", create);

    expect(create).toHaveBeenCalledTimes(1);
    expect(second.resumed).toBe(true);
    expect(second.managed).toBe(first.managed);
    expect(second.managed.connectionCount).toBe(1);
    expect(second.managed.closeTimer).toBeNull();
  });

  it("creates a fresh session after the retention window expires", async () => {
    const store = new InMemorySessionStore();
    const create = vi.fn(async () => createManagedSession("session-a"));
    const first = await store.lease("session-a", create);
    const firstSession = first.managed.session;
    first.managed.connectionCount = 0;
    await store.release("session-a", 10);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const second = await store.lease("session-a", create);

    expect(create).toHaveBeenCalledTimes(2);
    expect(second.resumed).toBe(false);
    expect(second.managed.session).not.toBe(firstSession);
    expect(await store.get("session-a")).toBe(second.managed);
  });

  it("closes immediately when retainMs is zero", async () => {
    const store = new InMemorySessionStore();
    const managed = createManagedSession("session-a");
    const closeSpy = vi.spyOn(managed.session, "close");
    await store.lease("session-a", async () => managed);
    managed.connectionCount = 0;
    await store.release("session-a", 0);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(await store.get("session-a")).toBeNull();
  });

  it("does not release while connections remain active", async () => {
    const store = new InMemorySessionStore();
    const managed = createManagedSession("session-a");
    const closeSpy = vi.spyOn(managed.session, "close");
    await store.lease("session-a", async () => managed);

    await store.release("session-a", 10);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(closeSpy).not.toHaveBeenCalled();
    expect(await store.get("session-a")).toBe(managed);
  });

  it("serializes concurrent leases so only one session is created", async () => {
    const store = new InMemorySessionStore();
    let createCount = 0;
    const create = vi.fn(async () => {
      createCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return createManagedSession("session-a");
    });

    const [first, second] = await Promise.all([
      store.lease("session-a", create),
      store.lease("session-a", create),
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(createCount).toBe(1);
    expect(first.managed).toBe(second.managed);
    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(true);
  });

  it("release with retainMs zero evicts immediately even when a retention timer is active", async () => {
    const store = new InMemorySessionStore();
    const managed = createManagedSession("session-a");
    const closeSpy = vi.spyOn(managed.session, "close");
    await store.lease("session-a", async () => managed);
    managed.connectionCount = 0;
    await store.release("session-a", 200);
    expect(managed.closeTimer).not.toBeNull();

    await store.release("session-a", 0);

    expect(managed.closeTimer).toBeNull();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(await store.get("session-a")).toBeNull();
  });

  it("persists turn metrics state across resumed connections", async () => {
    const store = new InMemorySessionStore();
    const managed = createManagedSession("session-a");
    const session = managed.session;
    await store.lease("session-a", async () => managed);

    const emitted: unknown[] = [];
    const firstTracker = new TurnMetricsTracker(session, (message) => emitted.push(message), managed.turnMetricsTurns);
    const disposers: Array<() => void> = [];
    firstTracker.wire(disposers);
    void session.start();

    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-resume",
      timestampMs: 100,
    });
    session.bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-resume",
      timestampMs: 200,
      text: "hello",
      confidence: 0.99,
    });
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "turn-resume",
      timestampMs: 300,
      text: "hi there.",
    });
    // Let the Main-route llm.delta land before the Media-route tts.audio below —
    // Media drains on its own loop and can otherwise race ahead of a same-tick
    // Main backlog, leaving the session's turn_latency short its llmTtftMs stage.
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Media, {
      kind: "tts.audio",
      contextId: "turn-resume",
      timestampMs: 500,
      audio: new Uint8Array(640),
      sampleRateHz: 16000,
    });
    await waitForCondition(() => managed.turnMetricsTurns.get("turn-resume")?.turnLatency !== undefined);

    for (const dispose of disposers.splice(0)) dispose();

    const resumedEmitted: unknown[] = [];
    const resumedTracker = new TurnMetricsTracker(session, (message) => resumedEmitted.push(message), managed.turnMetricsTurns);
    const resumedDisposers: Array<() => void> = [];
    resumedTracker.wire(resumedDisposers);

    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-resume",
      timestampMs: 700,
      playedOutMs: 20,
      complete: true,
    });
    await waitForCondition(() => resumedEmitted.length === 1);
    expect(resumedEmitted[0]).toMatchObject({
      type: "metrics",
      turnId: "turn-resume",
      speechEndMs: 100,
      llmTtftMs: 200,
      ttsTtfbMs: 200,
    });

    for (const dispose of resumedDisposers.splice(0)) dispose();
  });

  it("update applies mutations through the store seam", async () => {
    const store = new InMemorySessionStore();
    const managed = createManagedSession("session-a");
    await store.lease("session-a", async () => managed);

    store.update("session-a", (session) => {
      session.currentContextId = "turn-updated";
      session.inputSequence.lastSequence = 7;
    });

    const loaded = await store.get("session-a");
    expect(loaded?.currentContextId).toBe("turn-updated");
    expect(loaded?.inputSequence.lastSequence).toBe(7);
  });

  it("lists and clears all sessions", async () => {
    const store = new InMemorySessionStore();
    await store.lease("session-a", async () => createManagedSession("session-a"));
    await store.lease("session-b", async () => createManagedSession("session-b"));

    expect((await store.listAll()).map((session) => session.id).sort()).toEqual(["session-a", "session-b"]);

    await store.clear();
    expect(await store.listAll()).toEqual([]);
  });
});

describe("createVoiceWebSocketServer sessionStore seam", () => {
  it("routes resume through an injected SessionStore", async () => {
    const calls: Array<{ method: "lease" | "release" | "get"; sessionId: string; retainMs?: number }> = [];
    const backing = new InMemorySessionStore();
    const sessionStore: SessionStore = {
      lease: async (sessionId, create) => {
        calls.push({ method: "lease", sessionId });
        return backing.lease(sessionId, create);
      },
      release: async (sessionId, retainMs) => {
        calls.push({ method: "release", sessionId, retainMs });
        await backing.release(sessionId, retainMs);
      },
      update: (sessionId, mutate) => backing.update(sessionId, mutate),
      get: async (sessionId) => {
        calls.push({ method: "get", sessionId });
        return backing.get(sessionId);
      },
      listAll: () => backing.listAll(),
      clear: () => backing.clear(),
    };

    let created = 0;
    const session = new VoiceAgentSession({ plugins: {} });
    const { server, port } = await startLoopbackTransportServer(createVoiceWebSocketServer, {
      resumeWindowMs: 200,
      sessionStore,
      createSession: () => {
        created += 1;
        return session;
      },
      contextId: () => "turn-test",
    });

    const sessionUrl = `ws://127.0.0.1:${String(port)}/ws?sessionId=fake-store-test`;
    const [first, firstReady] = await openBrowserClientAndReadReady(sessionUrl);
    expect(firstReady).toMatchObject({ sessionId: "fake-store-test", resumed: false });
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [, secondReady] = await openBrowserClientAndReadReady(sessionUrl);
    expect(secondReady).toMatchObject({ sessionId: "fake-store-test", resumed: true });
    expect(created).toBe(1);
    expect(calls.filter((call) => call.method === "lease").map((call) => call.sessionId)).toEqual([
      "fake-store-test",
      "fake-store-test",
    ]);
    expect(calls.some((call) => call.method === "release" && call.sessionId === "fake-store-test" && call.retainMs === 200)).toBe(true);

    await server.close();
  });
});
