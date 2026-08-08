import { defineConfig } from "vitest/config";

/**
 * Shared vitest timeout for packages whose tests stand up local WebSocket servers
 * (port 0 bind + handshake + round trip). Non-socket packages keep vitest's 5s default.
 *
 * Measured 2026-08-08 under `pnpm -r test` (workspaceConcurrency: 2, full monorepo load):
 * socket tests hit the 5000ms vitest default at 5013–5016ms wall time before failing
 * (packages/deepgram/src/tts.test.ts, packages/server-websocket/src/index.test.ts).
 * In isolation the same tests finish in tens of milliseconds — the ceiling is scheduler
 * contention, not assertion work. Budget 15000ms = 3× the observed ~5s load ceiling.
 */
export const SOCKET_TEST_TIMEOUT_MS = 15_000;

export default defineConfig({
  test: {
    testTimeout: SOCKET_TEST_TIMEOUT_MS,
  },
});
