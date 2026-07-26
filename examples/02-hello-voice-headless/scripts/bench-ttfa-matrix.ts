// SPDX-License-Identifier: MIT
//
// Provider-matrix time-to-first-audio bench.
//
// The only headline number is speechEnd -> first TTS byte. Audio length is not
// latency, and `e2eLatencyMs` counts from feed start (so it contains the fixture's
// own duration) — neither is reported as speech-to-speech latency here.
//
// Feeds at 1x. Bursting a fixture in makes "speech end" mean "finished sending
// bytes" while the provider's endpointing timers keep running on wall clock, which
// inflates the STT leg into a number no caller would ever experience.
//
//   tsx runs/bench-matrix.ts --turns 3 [--combos deepgram+openai-tts,...]

import { performance } from "node:perf_hooks";

import { VoiceAgentSession, type VoicePlugin } from "@kuralle-syrinx/core";
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import { defineAgent, createRuntime, MemoryStore } from "@kuralle-agents/core";
import { createOpenAI } from "@ai-sdk/openai";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { ElevenLabsSTTPlugin, ElevenLabsTTSPlugin } from "@kuralle-syrinx/elevenlabs";
import { GrokSTTPlugin, GrokTTSPlugin } from "@kuralle-syrinx/grok";
import { OpenAICompatibleTTSPlugin } from "@kuralle-syrinx/openai-tts";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { driveTurn } from "@kuralle-syrinx/cli/turn-runner";
import { ensureRepoRootDotenv, coerceGoogleGenAiKey } from "../src/run-one-turn.js";

const env = (k: string): string => process.env[k] ?? "";

interface Stage {
  readonly plugin: () => VoicePlugin;
  readonly config: () => Record<string, unknown>;
  readonly needs: string;
}

const STT: Record<string, Stage> = {
  deepgram: {
    plugin: () => new DeepgramSTTPlugin(),
    config: () => ({ api_key: env("DEEPGRAM_API_KEY"), model: "nova-3", sample_rate: 16000, emit_eos_on_final: true }),
    needs: "DEEPGRAM_API_KEY",
  },
  elevenlabs: {
    plugin: () => new ElevenLabsSTTPlugin(),
    config: () => ({ api_key: env("ELEVENLABS_API_KEY"), sample_rate: 16000, emit_eos_on_final: true }),
    needs: "ELEVENLABS_API_KEY",
  },
  grok: {
    plugin: () => new GrokSTTPlugin(),
    config: () => ({ api_key: env("GROK_API_KEY") || env("XAI_API_KEY"), sample_rate: 16000, emit_eos_on_final: true }),
    needs: "GROK_API_KEY|XAI_API_KEY",
  },
};

const TTS: Record<string, Stage> = {
  "openai-tts": {
    plugin: () => new OpenAICompatibleTTSPlugin(),
    config: () => ({ api_key: env("OPENAI_API_KEY"), model: "gpt-4o-mini-tts", voice: "alloy" }),
    needs: "OPENAI_API_KEY",
  },
  elevenlabs: {
    plugin: () => new ElevenLabsTTSPlugin(),
    config: () => ({ api_key: env("ELEVENLABS_API_KEY") }),
    needs: "ELEVENLABS_API_KEY",
  },
  grok: {
    plugin: () => new GrokTTSPlugin(),
    config: () => ({ api_key: env("GROK_API_KEY") || env("XAI_API_KEY") }),
    needs: "GROK_API_KEY|XAI_API_KEY",
  },
  cartesia: {
    plugin: () => new CartesiaTTSPlugin(),
    config: () => ({ api_key: env("CARTESIA_API_KEY"), voice_id: env("CARTESIA_VOICE_ID") }),
    needs: "CARTESIA_API_KEY",
  },
};

const SYSTEM = "You are a terse voice assistant. One short sentence.";

/**
 * The reasoner under test. Both drive the same model through the same
 * ReasoningBridge seam, so a TTFT difference is the framework's, not the model's.
 */
function makeReasoner(kind: "aisdk" | "kuralle"): ConstructorParameters<typeof ReasoningBridge>[0] {
  const openai = createOpenAI({ apiKey: env("OPENAI_API_KEY") });
  if (kind === "aisdk") {
    return fromStreamText({ model: openai("gpt-4.1-mini"), system: SYSTEM });
  }
  const runtime = createRuntime({
    agents: [defineAgent({ id: "bench", model: openai("gpt-4.1-mini"), instructions: SYSTEM })],
    defaultAgentId: "bench",
    sessionStore: new MemoryStore(),
  });
  return fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, { sessionId: `bench-${String(Date.now())}` });
}

function makeSession(sttName: string, ttsName: string, reasoner: "aisdk" | "kuralle" = "aisdk"): VoiceAgentSession {
  const stt = STT[sttName];
  const tts = TTS[ttsName];
  if (!stt || !tts) throw new Error(`unknown combo ${sttName}+${ttsName}`);
  const openai = createOpenAI({ apiKey: env("OPENAI_API_KEY") });
  const session = new VoiceAgentSession({
    plugins: { stt: stt.config(), bridge: {}, tts: tts.config() },
    endpointingOwner: "provider_stt",
  });
  const plugins: Record<string, VoicePlugin> = {
    stt: stt.plugin(),
    bridge: new ReasoningBridge(makeReasoner(reasoner)),
    tts: tts.plugin(),
  };
  for (const [n, p] of Object.entries(plugins)) session.registerPlugin(n, p);
  return session;
}

const pct = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? 0;
};
const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();

  const turns = Number.parseInt(arg("--turns", "3"), 10);
  const wav = arg("--in", "../../runs/captured-fixture/captured.wav");
  const combos = arg("--combos", "deepgram+openai-tts,deepgram+elevenlabs,deepgram+cartesia,elevenlabs+openai-tts,grok+grok")
    .split(",").map((c) => c.trim()).filter(Boolean);

  const results: unknown[] = [];
  for (const combo of combos) {
    const [sttName = "", ttsName = "", reasonerName = "aisdk"] = combo.split("+");
    const missing = [STT[sttName]?.needs, TTS[ttsName]?.needs].filter((k): k is string => Boolean(k) && !k.split("|").some((one) => env(one) !== ""));
    if (!STT[sttName] || !TTS[ttsName]) { results.push({ combo, skipped: "unknown provider" }); continue; }
    if (missing.length > 0) { results.push({ combo, skipped: `missing ${missing.join(",")}` }); continue; }

    const rows: Record<string, unknown>[] = [];
    let failure: string | undefined;
    for (let i = 0; i < turns; i += 1) {
      try {
        let latency: Record<string, unknown> | undefined;
        const r = await driveTurn({
          session: () => {
            const sess = makeSession(sttName, ttsName, reasonerName === "kuralle" ? "kuralle" : "aisdk");
            // The engine's OWN decomposition. The runner's ttsTTFBMs is
            // firstAudio - firstLlmDelta, which silently folds the engine's text
            // aggregation into the provider's synthesis time; this separates them.
            sess.on("turn_latency", (e) => {
              latency = {
                ttfaMs: e.ttfaMs, anchor: e.anchor, eouDelayMs: e.eouDelayMs,
                llmTtftMs: e.llmTtftMs, textAggregationMs: e.textAggregationMs,
                ttsTtfbMs: e.ttsTtfbMs, unattributedMs: e.unattributedMs,
              };
            });
            return sess;
          },
          inputWavPath: wav,
          sessionDir: `/tmp/bench-matrix/${combo.replace("+", "-")}/${String(i)}`,
          realtimePacing: true,
        });
        const m = r.metrics;
        rows.push({
          turn: i + 1, sttMs: m.speechEndToFinalTranscriptMs, llmTtftMs: m.llmTTFTMs,
          ttsTtfbMs: m.ttsTTFBMs, ttfaMs: m.speechEndToFirstAudioMs,
          ...(latency !== undefined ? { engine: latency } : {}),
        });
        process.stderr.write(`${combo} turn ${String(i + 1)}: ttfa=${String(m.speechEndToFirstAudioMs)}ms\n`);
      } catch (e) {
        failure = e instanceof Error ? e.message.slice(0, 140) : String(e);
        process.stderr.write(`${combo} turn ${String(i + 1)} FAILED: ${failure}\n`);
        break;
      }
    }
    // Turn 1 pays every provider's connection setup; excluded from the aggregate.
    const warm = rows.slice(1).length > 0 ? rows.slice(1) : rows;
    results.push({
      combo,
      ...(failure !== undefined ? { failure } : {}),
      coldStartTtfaMs: rows[0]?.["ttfaMs"] ?? null,
      warmTtfaMedianMs: pct(warm.map((r) => Number(r["ttfaMs"])), 50),
      stageMedians: {
        sttMs: pct(warm.map((r) => Number(r["sttMs"])), 50),
        llmTtftMs: pct(warm.map((r) => Number(r["llmTtftMs"])), 50),
        ttsTtfbMs: pct(warm.map((r) => Number(r["ttsTtfbMs"])), 50),
      },
      turns: rows,
    });
  }
  console.log(JSON.stringify({ fixture: wav, pacing: "realtime-1x", results }, null, 2));
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
