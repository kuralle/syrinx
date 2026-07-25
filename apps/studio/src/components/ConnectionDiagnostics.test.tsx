// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectionDiagnostics } from "./ConnectionDiagnostics";
import type { ConnectionFailure } from "@/hooks/useSyrinxSession";

const DECLARED = [
  { worker: "syrinx-voice-server-workers", className: "VoiceConversation" },
  { worker: "syrinx-cf-agent-voice-example", className: "RealtimeVoiceAgent" },
] as const;

const failure = (over: Partial<ConnectionFailure> & Pick<ConnectionFailure, "kind">): ConnectionFailure => ({
  wsUrl: "ws://127.0.0.1:4173/ws",
  ...over,
});

describe("ConnectionDiagnostics", () => {
  it("shows nothing at all while the session is healthy", () => {
    const { container } = render(<ConnectionDiagnostics declaredDurableObjects={DECLARED} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("distinguishes nothing-listening from the other failures, and says what to do", () => {
    render(
      <ConnectionDiagnostics
        failure={failure({ kind: "refused", retryingAttempt: 1 })}
        declaredDurableObjects={DECLARED}
      />,
    );
    expect(screen.getByTestId("connection-failure-headline")).toHaveTextContent(
      /nothing is listening/i,
    );
    expect(screen.getByTestId("connection-failure-next")).toHaveTextContent(/start the backend/i);
    expect(screen.getByTestId("connection-failure-target")).toHaveTextContent(/ws:\/\/127\.0\.0\.1:4173\/ws/);
    expect(screen.getByTestId("connection-failure-target")).toHaveTextContent(/still retrying/i);
    // A wrong path is a different problem — do not teach a route for a dead port.
    expect(screen.queryByTestId("agent-route-hint")).not.toBeInTheDocument();
  });

  it("teaches the route shape and names the classes wrangler.jsonc declares", () => {
    render(
      <ConnectionDiagnostics
        failure={failure({ kind: "upgrade-rejected", wsUrl: "wss://worker.test/ws" })}
        declaredDurableObjects={DECLARED}
      />,
    );
    expect(screen.getByTestId("connection-failure-headline")).toHaveTextContent(/not on that path/i);
    expect(screen.getByTestId("agent-route-hint")).toHaveTextContent(
      "/agents/<class-name-kebab>/<id>",
    );
    const candidates = screen.getAllByTestId("agent-route-candidate");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toHaveTextContent("/agents/voice-conversation/default");
    expect(candidates[0]).toHaveTextContent("VoiceConversation in syrinx-voice-server-workers");
    expect(candidates[1]).toHaveTextContent("/agents/realtime-voice-agent/default");
  });

  it("offers the derived route as one click on the actual host", () => {
    const onUseUrl = vi.fn();
    render(
      <ConnectionDiagnostics
        failure={failure({ kind: "upgrade-rejected", wsUrl: "wss://worker.test/ws" })}
        declaredDurableObjects={DECLARED}
        onUseUrl={onUseUrl}
      />,
    );
    screen.getAllByRole("button", { name: /use this path/i })[0]?.click();
    expect(onUseUrl).toHaveBeenCalledWith("wss://worker.test/agents/voice-conversation/default");
  });

  it("teaches the shape without inventing a class when no config was readable", () => {
    render(
      <ConnectionDiagnostics
        failure={failure({ kind: "upgrade-rejected" })}
        declaredDurableObjects={[]}
      />,
    );
    expect(screen.getByTestId("agent-route-hint")).toHaveTextContent(
      "/agents/<class-name-kebab>/<id>",
    );
    expect(screen.getByTestId("agent-route-unknown")).toHaveTextContent(/no class to name here/i);
    expect(screen.queryByTestId("agent-route-candidates")).not.toBeInTheDocument();
  });

  it("distinguishes an agent that failed to start, and shows what the server said", () => {
    render(
      <ConnectionDiagnostics
        failure={failure({
          kind: "agent-init-failed",
          closeCode: 1011,
          closeReason: "session failed",
          serverError: {
            component: "session",
            category: "initialization",
            message: "DEEPGRAM_API_KEY is not set",
          },
        })}
        declaredDurableObjects={DECLARED}
      />,
    );
    expect(screen.getByTestId("connection-failure-headline")).toHaveTextContent(
      /accepted, then the agent failed to start/i,
    );
    expect(screen.getByTestId("connection-failure-server-error")).toHaveTextContent(
      "DEEPGRAM_API_KEY is not set",
    );
    expect(screen.getByTestId("connection-failure-server-error")).toHaveTextContent(
      "session · initialization",
    );
    expect(screen.getByTestId("connection-failure-raw")).toHaveTextContent("close 1011");
    // The path was right — the socket opened. Teaching a route here would mislead.
    expect(screen.queryByTestId("agent-route-hint")).not.toBeInTheDocument();
  });

  it("says it could not tell, instead of picking the likeliest and sounding sure", () => {
    render(
      <ConnectionDiagnostics
        failure={failure({ kind: "unclassified" })}
        declaredDurableObjects={DECLARED}
      />,
    );
    expect(screen.getByTestId("connection-failure-headline")).toHaveTextContent(
      /did not say why/i,
    );
    // A wrong path is still the most common cause, so the route is still taught.
    expect(screen.getByTestId("agent-route-hint")).toBeInTheDocument();
  });

  it("renders no two failures the same way", () => {
    const headlines = (["refused", "upgrade-rejected", "agent-init-failed", "unclassified"] as const).map(
      (kind) => {
        const { unmount } = render(
          <ConnectionDiagnostics failure={failure({ kind })} declaredDurableObjects={DECLARED} />,
        );
        const text = screen.getByTestId("connection-failure-headline").textContent;
        unmount();
        return text;
      },
    );
    expect(new Set(headlines).size).toBe(4);
    // And not one of them is a bare status word.
    for (const headline of headlines) expect(headline?.split(" ").length).toBeGreaterThan(3);
  });

  it("counts down the resume window after a dropped session", () => {
    render(
      <ConnectionDiagnostics
        resumeWindowMs={60_000}
        disconnectedAtMs={Date.now() - 20_000}
        declaredDurableObjects={DECLARED}
      />,
    );
    expect(screen.getByTestId("connection-failure-headline")).toHaveTextContent(/session dropped/i);
    expect(screen.getByTestId("resume-window-open")).toHaveTextContent(/picks this session back up/i);
    expect(screen.queryByTestId("resume-window-elapsed")).not.toBeInTheDocument();
  });

  it("says explicitly when the resume window has elapsed", () => {
    render(
      <ConnectionDiagnostics
        resumeWindowMs={60_000}
        disconnectedAtMs={Date.now() - 90_000}
        declaredDurableObjects={DECLARED}
      />,
    );
    expect(screen.getByTestId("resume-window-elapsed")).toHaveTextContent(/has elapsed/i);
    expect(screen.getByTestId("resume-window-elapsed")).toHaveTextContent(/starts a new session/i);
    expect(screen.queryByTestId("resume-window-open")).not.toBeInTheDocument();
  });

  it("claims no resume window when the server never sent one", () => {
    render(
      <ConnectionDiagnostics
        disconnectedAtMs={Date.now() - 1_000}
        declaredDurableObjects={DECLARED}
      />,
    );
    expect(screen.queryByTestId("resume-window-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("resume-window-elapsed")).not.toBeInTheDocument();
  });

  it("has the workspace's declared classes compiled in, with no prop supplied", () => {
    // Proves the build-time wiring exists: vite.config.ts reads wrangler.jsonc and
    // inlines the result, so the default is real data rather than a literal here.
    render(<ConnectionDiagnostics failure={failure({ kind: "upgrade-rejected" })} />);
    expect(screen.getByTestId("agent-route-hint")).toBeInTheDocument();
    expect(__SYRINX_DECLARED_DURABLE_OBJECTS__).toBeInstanceOf(Array);
  });
});
