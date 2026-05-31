// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { chromeLaunchArgs } from "../scripts/run-browser-runtime-capture-smoke.js";

describe("browser runtime smoke launch args", () => {
  it("includes a real fake-mic wav instead of Chrome's synthetic beep", () => {
    const args = chromeLaunchArgs("http://127.0.0.1:8080", 9222, "/tmp/chrome-profile");

    expect(args).toContain("--use-fake-device-for-media-stream");
    expect(args.some((arg) => arg.startsWith("--use-file-for-fake-audio-capture="))).toBe(true);
  });
});
