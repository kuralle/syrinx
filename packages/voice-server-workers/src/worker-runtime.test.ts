// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";

type WorkersWebSocket = WebSocket & {
  accept(): void;
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("VoiceConversation worker runtime", () => {
  it("accepts a WebSocket in workerd and drives one audio turn to outbound TTS", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "syrinx-worker-"));
    tempDirs.push(tmp);
    const outfile = join(tmp, "worker.js");
    await build({
      entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser"],
      outfile,
      logLevel: "silent",
    });

    const mf = new Miniflare({
      modules: true,
      script: await readFile(outfile, "utf8"),
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        VOICE_CONVERSATIONS: { className: "VoiceConversation", useSQLite: true },
      },
    });
    try {
      const response = await mf.dispatchFetch("http://localhost/ws?sessionId=runtime-turn", {
        headers: { Upgrade: "websocket" },
      });
      expect(response.status).toBe(101);
      const ws = (response as unknown as Response & { webSocket?: WorkersWebSocket }).webSocket;
      expect(ws).toBeTruthy();
      const messages: Array<string | ArrayBuffer> = [];
      ws!.addEventListener("message", (event) => {
        messages.push(event.data as string | ArrayBuffer);
      });
      ws!.accept();
      ws!.send(JSON.stringify({
        type: "audio",
        audio: "AAAA",
        sampleRateHz: 16000,
        sequence: 1,
      }));

      await waitFor(() => messages.some((message) =>
        typeof message === "string" && message.includes('"type":"tts_chunk"')
      ));

      expect(messages.some((message) =>
        typeof message === "string" && message.includes('"type":"ready"')
      )).toBe(true);
      expect(messages.some((message) =>
        typeof message === "string" && message.includes('"type":"tts_end"')
      )).toBe(true);
      expect(messages.some((message) => message instanceof ArrayBuffer)).toBe(true);
      ws!.close();
    } finally {
      await mf.dispose();
    }
  }, 20_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for worker websocket output");
}
