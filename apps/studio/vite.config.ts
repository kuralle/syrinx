import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { readDeclaredDurableObjects } from "./scripts/wrangler-classes";

// Design rule 6: never hardcode an agent route. The Durable Object classes a
// workspace declares are read here, at build time, and inlined — so a connection
// error can name the actual classes instead of a guess, and the studio stays a
// pure client at runtime (no filesystem, no config fetch). When nothing is
// readable the array is empty and the UI teaches the route shape alone.
const declaredDurableObjects = readDeclaredDurableObjects(path.resolve(__dirname, "../.."));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __SYRINX_DECLARED_DURABLE_OBJECTS__: JSON.stringify(declaredDurableObjects),
  },
  // Modern target: the default (es2020/chrome87/…) makes esbuild fail to down-transpile
  // destructuring in some bundled dep chunks (surfaced after the esbuild 0.28 bump). Every
  // browser that reaches this Workers-hosted playground supports es2022 natively.
  build: {
    target: "es2022",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // e2e/ is Playwright: a real Chromium against a live backend. Running it here
    // would make the unit gate depend on provider keys and a booted server.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
