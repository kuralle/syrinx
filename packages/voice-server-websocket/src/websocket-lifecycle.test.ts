// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { installGracefulShutdown, type GracefulClosable } from "./websocket-lifecycle.js";

describe("installGracefulShutdown", () => {
  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("drains the server gracefully on a termination signal", async () => {
    const closeCalls: Array<{ graceful?: boolean; drainDeadlineMs?: number }> = [];
    const server: GracefulClosable = {
      close: async (opts) => {
        closeCalls.push(opts ?? {});
      },
    };
    const onClosed = vi.fn();
    installGracefulShutdown(server, { drainDeadlineMs: 7000, onClosed });

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));

    expect(closeCalls).toEqual([{ graceful: true, drainDeadlineMs: 7000 }]);
  });

  it("is idempotent — a second signal during shutdown does not double-close", async () => {
    let closeCount = 0;
    const server: GracefulClosable = { close: async () => { closeCount += 1; } };
    installGracefulShutdown(server, { signals: ["SIGTERM"] });

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(closeCount).toBe(1));
    expect(closeCount).toBe(1);
  });

  it("the disposer removes the signal handler", async () => {
    let closeCount = 0;
    const server: GracefulClosable = { close: async () => { closeCount += 1; } };
    const dispose = installGracefulShutdown(server, { signals: ["SIGINT"] });
    dispose();

    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 10));
    expect(closeCount).toBe(0);
  });
});
