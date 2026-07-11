import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  },
});
