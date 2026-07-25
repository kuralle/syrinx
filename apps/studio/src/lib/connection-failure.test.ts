// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";

import {
  agentRouteCandidates,
  classifyConnectionFailure,
  classNameToRouteSegment,
  httpProbeUrl,
  probeReachable,
  resumeStatus,
} from "./connection-failure";

describe("classifyConnectionFailure", () => {
  it("names nothing-listening when no HTTP request was answered either", () => {
    expect(classifyConnectionFailure({ everOpened: false, reachable: false })).toBe("refused");
  });

  it("names a rejected upgrade when the address answered but the socket never opened", () => {
    expect(classifyConnectionFailure({ everOpened: false, reachable: true })).toBe(
      "upgrade-rejected",
    );
  });

  it("names an agent that failed to start when the socket opened and then died", () => {
    expect(
      classifyConnectionFailure({
        everOpened: true,
        closeCode: 1011,
        serverError: { component: "session", category: "initialization", message: "no API key" },
      }),
    ).toBe("agent-init-failed");
  });

  it("prefers what the socket did over what the probe said", () => {
    // A socket that opened proves the address and the path; a probe that could not
    // reach the same host over plain HTTP does not unprove it.
    expect(classifyConnectionFailure({ everOpened: true, reachable: false })).toBe(
      "agent-init-failed",
    );
  });

  it("admits it could not tell rather than guessing", () => {
    expect(classifyConnectionFailure({ everOpened: false })).toBe("unclassified");
  });
});

describe("classNameToRouteSegment", () => {
  // Must match `camelCaseToKebabCase` in agents/dist/utils.js exactly — a route
  // that disagrees with the SDK's would teach the wrong path.
  it.each([
    ["VoiceConversation", "voice-conversation"],
    ["TelnyxVoiceConversation", "telnyx-voice-conversation"],
    ["RealtimeVoiceAgent", "realtime-voice-agent"],
    ["Chat", "chat"],
    ["MY_AGENT", "my-agent"],
    ["snake_case_agent", "snake-case-agent"],
  ])("%s -> %s", (className, expected) => {
    expect(classNameToRouteSegment(className)).toBe(expected);
  });
});

describe("agentRouteCandidates", () => {
  it("builds a usable URL per declared class, keeping the current host", () => {
    const candidates = agentRouteCandidates("ws://127.0.0.1:8787/ws", [
      { worker: "voice", className: "VoiceConversation" },
      { worker: "example", className: "RealtimeVoiceAgent" },
    ]);
    expect(candidates).toEqual([
      {
        worker: "voice",
        className: "VoiceConversation",
        path: "/agents/voice-conversation/default",
        url: "ws://127.0.0.1:8787/agents/voice-conversation/default",
      },
      {
        worker: "example",
        className: "RealtimeVoiceAgent",
        path: "/agents/realtime-voice-agent/default",
        url: "ws://127.0.0.1:8787/agents/realtime-voice-agent/default",
      },
    ]);
  });

  it("suggests nothing when the target is not a URL, rather than a guess", () => {
    expect(agentRouteCandidates("not a url", [{ worker: "w", className: "A" }])).toEqual([]);
  });

  it("suggests nothing when no class was readable", () => {
    expect(agentRouteCandidates("wss://example.test/ws", [])).toEqual([]);
  });
});

describe("resumeStatus", () => {
  it("reports the remaining window while it is open", () => {
    const status = resumeStatus({ resumeWindowMs: 60_000, disconnectedAtMs: 1_000, nowMs: 21_000 });
    expect(status).toEqual({ state: "open", remainingMs: 40_000 });
  });

  it("says the window elapsed rather than showing a negative countdown", () => {
    const status = resumeStatus({ resumeWindowMs: 60_000, disconnectedAtMs: 1_000, nowMs: 91_000 });
    expect(status).toEqual({ state: "elapsed", remainingMs: 0 });
  });

  it("has nothing to report when the server never sent a window", () => {
    expect(resumeStatus({ disconnectedAtMs: 1_000, nowMs: 2_000 }).state).toBe("none");
  });

  it("has nothing to report when no session ever dropped", () => {
    expect(resumeStatus({ resumeWindowMs: 60_000, nowMs: 2_000 }).state).toBe("none");
  });
});

describe("httpProbeUrl", () => {
  it.each([
    ["ws://127.0.0.1:4173/ws", "http://127.0.0.1:4173/ws"],
    ["wss://example.test/agents/a/b", "https://example.test/agents/a/b"],
  ])("%s -> %s", (wsUrl, expected) => {
    expect(httpProbeUrl(wsUrl)).toBe(expected);
  });

  it("has no probe address for something that is not a URL", () => {
    expect(httpProbeUrl("nonsense")).toBeUndefined();
  });
});

describe("probeReachable", () => {
  it("is reachable when any answer comes back, whatever the status", () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 426 }));
    return expect(probeReachable("ws://host.test/ws", fetchImpl as unknown as typeof fetch)).resolves.toBe(
      true,
    );
  });

  it("is unreachable when the request fails at the network level", () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    return expect(probeReachable("ws://host.test/ws", fetchImpl as unknown as typeof fetch)).resolves.toBe(
      false,
    );
  });

  it("decides nothing when the probe itself fails for another reason", () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    return expect(
      probeReachable("ws://host.test/ws", fetchImpl as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it("decides nothing when there is no address to probe", () =>
    expect(probeReachable("nonsense", vi.fn() as unknown as typeof fetch)).resolves.toBeUndefined());
});
