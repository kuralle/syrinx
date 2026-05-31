// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { VoiceAgentSession } from "@asyncdot/voice";
import { createVoiceWebSocketServer } from "./index.js";
import {
  InMemorySessionStore,
  type ManagedSession,
  type SessionStore,
} from "./session-store.js";
import {
  openBrowserClientAndReadReady,
  registerServer,
  setupTransportTestCleanup,
} from "./test-helpers.js";

setupTransportTestCleanup();

function createManagedSession(id: string): ManagedSession {
  return {
    id,
    session: new VoiceAgentSession({ plugins: {} }),
    currentContextId: "turn-test",
    contextSampleRates: new Map(),
    inputSequence: { lastSequence: null },
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
      get: async (sessionId) => {
        calls.push({ method: "get", sessionId });
        return backing.get(sessionId);
      },
      listAll: () => backing.listAll(),
      clear: () => backing.clear(),
    };

    let created = 0;
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      resumeWindowMs: 200,
      sessionStore,
      createSession: () => {
        created += 1;
        return session;
      },
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const sessionUrl = `ws://127.0.0.1:${String(address.port)}/ws?sessionId=fake-store-test`;
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
