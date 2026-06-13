// SPDX-License-Identifier: MIT

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PipelineBusImpl, Route, type TextToSpeechAudioPacket, type TextToSpeechEndPacket } from "@kuralle-syrinx/core";

import { EpsilonTTSPlugin } from "./index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LIVE_OUTPUT_PATH = join(REPO_ROOT, ".handoff/proof-epsilon-live.txt");

const EPSILON_LIVE_BASE_URL = process.env["EPSILON_BASE_URL"] ?? "";
const EPSILON_LIVE_API_KEY = process.env["EPSILON_API_KEY"] ?? "";
const LIVE_TEXT = "හරි, මම බලන්නම්.";
const MIN_PCM_BYTES_FOR_ONE_SECOND = 24_000 * 2;

const liveEnabled =
  process.env["SYRINX_LIVE_EPSILON_TEST"] === "1" && EPSILON_LIVE_BASE_URL !== "" && EPSILON_LIVE_API_KEY !== "";

describe.skipIf(!liveEnabled)("EpsilonTTSPlugin live", () => {
  it(
    "connects to the live endpoint and receives at least one second of pcm plus done",
    async () => {
      const bus = new PipelineBusImpl();
      const started = bus.start();
      const plugin = new EpsilonTTSPlugin();
      const audio: TextToSpeechAudioPacket[] = [];
      const ends: TextToSpeechEndPacket[] = [];
      const lines: string[] = [];

      bus.on("tts.audio", (pkt) => {
        audio.push(pkt as TextToSpeechAudioPacket);
      });
      bus.on("tts.end", (pkt) => {
        ends.push(pkt as TextToSpeechEndPacket);
      });

      const startedAt = Date.now();
      await plugin.initialize(bus, {
        api_key: EPSILON_LIVE_API_KEY,
        base_url: EPSILON_LIVE_BASE_URL,
        voice: "sinhala",
        sample_rate: 24000,
      });

      bus.push(Route.Main, {
        kind: "tts.text",
        contextId: "live-turn-1",
        timestampMs: Date.now(),
        text: LIVE_TEXT,
      });
      bus.push(Route.Main, {
        kind: "tts.done",
        contextId: "live-turn-1",
        timestampMs: Date.now(),
        text: LIVE_TEXT,
      });

      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const pcmBytes = audio.reduce((sum, pkt) => sum + pkt.audio.byteLength, 0);
        if (pcmBytes >= MIN_PCM_BYTES_FOR_ONE_SECOND && ends.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const pcmBytes = audio.reduce((sum, pkt) => sum + pkt.audio.byteLength, 0);
      const elapsedMs = Date.now() - startedAt;
      const ttfaMs = audio[0] ? audio[0].timestampMs - startedAt : null;

      lines.push(`elapsed_ms=${String(elapsedMs)}`);
      lines.push(`ttfa_ms=${ttfaMs === null ? "null" : String(ttfaMs)}`);
      lines.push(`pcm_bytes=${String(pcmBytes)}`);
      lines.push(`audio_chunks=${String(audio.length)}`);
      lines.push(`done_messages=${String(ends.length)}`);
      lines.push(`text=${LIVE_TEXT}`);

      mkdirSync(dirname(LIVE_OUTPUT_PATH), { recursive: true });
      writeFileSync(LIVE_OUTPUT_PATH, `${lines.join("\n")}\n`, "utf8");

      expect(pcmBytes).toBeGreaterThanOrEqual(MIN_PCM_BYTES_FOR_ONE_SECOND);
      expect(ends).toEqual([expect.objectContaining({ contextId: "live-turn-1" })]);

      await plugin.close();
      bus.stop();
      await started;
    },
    120_000,
  );
});
