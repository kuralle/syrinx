// SPDX-License-Identifier: MIT
//
// Raw provider latency with NO Syrinx engine in the path — plain fetch, streaming,
// timed to first byte of useful output.
//
// This is the control. The engine bench says TTFA ~= llmTTFT + ttsTTFB; if those
// same numbers show up here, the latency is the provider/network and the engine
// adds ~nothing. If the engine's are materially higher, the difference is ours and
// is the thing to fix.
//
//   tsx scripts/bench-raw-providers.ts --n 3

import { performance } from "node:perf_hooks";

import { ensureRepoRootDotenv, coerceGoogleGenAiKey } from "../src/run-one-turn.js";

const env = (k: string): string => process.env[k] ?? "";
const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

const PROMPT = "What's the application deadline for the computer science masters?";

/** Time to the first streamed content token from an OpenAI-compatible chat endpoint. */
async function llmTtft(model: string, base: string, key: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: "You are a terse voice assistant. One short sentence." },
        { role: "user", content: PROMPT },
      ],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`${model}: HTTP ${String(res.status)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = dec.decode(value, { stream: true });
    // First chunk carrying actual content, not just the role preamble.
    if (/"content":"[^"]/.test(text)) {
      const ms = performance.now() - t0;
      void reader.cancel();
      return Math.round(ms);
    }
  }
  throw new Error(`${model}: stream ended with no content`);
}

/** Time to the first audio byte from a TTS endpoint. */
async function ttsTtfb(name: string, run: () => Promise<Response>): Promise<number> {
  const t0 = performance.now();
  const res = await run();
  if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${String(res.status)}`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const ms = performance.now() - t0;
  void reader.cancel();
  if (!value || value.byteLength === 0) throw new Error(`${name}: empty first chunk`);
  return Math.round(ms);
}

const REPLY = "Please specify the university for that deadline.";

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const n = Number.parseInt(arg("--n", "3"), 10);

  const llms: Record<string, () => Promise<number>> = {
    "openai/gpt-4.1-mini": () => llmTtft("gpt-4.1-mini", "https://api.openai.com/v1", env("OPENAI_API_KEY")),
    "xai/grok-4-fast": () => llmTtft("grok-4-fast", "https://api.x.ai/v1", env("XAI_API_KEY") || env("GROK_API_KEY")),
  };

  const ttss: Record<string, () => Promise<number>> = {
    "openai-tts/gpt-4o-mini-tts": () => ttsTtfb("openai-tts", () =>
      fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env("OPENAI_API_KEY")}` },
        body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: REPLY, response_format: "pcm" }),
      })),
    "elevenlabs/flash": () => ttsTtfb("elevenlabs", () =>
      fetch("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream?output_format=pcm_16000", {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": env("ELEVENLABS_API_KEY") },
        body: JSON.stringify({ text: REPLY, model_id: "eleven_flash_v2_5" }),
      })),
  };

  const out: Record<string, unknown> = { region: "local (origin machine)", samples: n };
  for (const [group, set] of [["llmTtftMs", llms], ["ttsTtfbMs", ttss]] as const) {
    const g: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(set)) {
      const xs: number[] = [];
      let err: string | undefined;
      for (let i = 0; i < n; i += 1) {
        try { xs.push(await fn()); } catch (e) { err = e instanceof Error ? e.message.slice(0, 90) : String(e); break; }
      }
      // First call pays TLS + connection setup, as it does in the engine.
      const warm = xs.slice(1).length > 0 ? xs.slice(1) : xs;
      g[name] = err !== undefined ? { error: err } : { cold: xs[0], warmMedian: median(warm), all: xs };
    }
    out[group] = g;
  }
  console.log(JSON.stringify(out, null, 2));
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
