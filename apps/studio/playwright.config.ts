// SPDX-License-Identifier: MIT
//
// E2E lives apart from the vitest suite on purpose: it needs a real Chromium and a
// live backend, so it must never run inside `pnpm -r test` and make the gate depend
// on provider keys.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
});
