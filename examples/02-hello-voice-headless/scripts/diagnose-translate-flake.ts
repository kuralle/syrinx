// SPDX-License-Identifier: MIT
// DIAGNOSTIC (throwaway): is the Gemini translate "flake" the MODEL echoing English, or the
// smoke's verifier mislabeling Spanish output? Runs translate N×, saves each output WAV, and
// labels each with a DETERMINISTIC detector (Deepgram detect_language) — not an LLM judge.

import { pathToFileURL } from "node:url";
import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";
import { createGeminiTranslateSession } from "@kuralle-syrinx/realtime";

const N = 5;
const FRAME = Number(process.env["DIAG_FRAME"] ?? 320); // 320=20ms, 1600=100ms @16k
const FIXTURE = new URL("../test/fixtures/university-cs-masters-deadline.wav", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deepgramDetect(pcm24k: Uint8Array): Promise<{ lang: string; text: string }> {
  const key = process.env["DEEPGRAM_API_KEY"]!;
  const res = await fetch(
    "https://api.deepgram.com/v1/listen?detect_language=true&encoding=linear16&sample_rate=24000&model=nova-2",
    { method: "POST", headers: { Authorization: `Token ${key}`, "content-type": "audio/raw" }, body: Buffer.from(pcm24k) },
  );
  const j = (await res.json()) as { results?: { channels?: Array<{ detected_language?: string; alternatives?: Array<{ transcript?: string }> }> } };
  const ch = j.results?.channels?.[0];
  return { lang: ch?.detected_language ?? "?", text: (ch?.alternatives?.[0]?.transcript ?? "").slice(0, 70) };
}

async function runOnce(apiKey: string, target: string, echo: boolean): Promise<{ out: Uint8Array; geminiText: string }> {
  const chunks: Uint8Array[] = [];
  let geminiText = "";
  const session = await createGeminiTranslateSession({
    apiKey, targetLanguageCode: target, echoTargetLanguage: echo,
    onAudio: (pcm) => chunks.push(pcm),
    onText: (t, role, final) => { if (role === "output" && final) geminiText += t; },
  });
  const pcm = readPcm16Mono16kWav(FIXTURE);
  for (let o = 0; o < pcm.length; o += FRAME) {
    const f = new Int16Array(FRAME);
    f.set(pcm.subarray(o, Math.min(o + FRAME, pcm.length)));
    session.sendAudio(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
    await sleep(20);
  }
  for (let i = 0; i < 75; i++) { session.sendAudio(new Uint8Array(FRAME * 2)); await sleep(20); } // 1.5s trailing silence
  await sleep(12_000); // collect output
  await session.close();
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total); let off = 0; for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return { out, geminiText };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["GEMINI_API_KEY"]!;
  const target = process.env["DIAG_TARGET"] ?? "es";
  const echo = process.env["DIAG_ECHO"] !== "false";
  console.log(`diagnose translate flake — N=${N}, target=${target}, echoTargetLanguage=${echo}, frame=${FRAME} (${Math.round((FRAME / 16000) * 1000)}ms)\n`);
  let spanish = 0, english = 0, other = 0, empty = 0;
  for (let i = 1; i <= N; i++) {
    try {
      const { out, geminiText } = await runOnce(apiKey, target, echo);
      if (out.byteLength < 1000) { empty++; console.log(`run ${i}: EMPTY output (${out.byteLength}B)`); continue; }
      const d = await deepgramDetect(out);
      const label = d.lang.startsWith("es") ? (spanish++, "SPANISH") : d.lang.startsWith("en") ? (english++, "ENGLISH") : (other++, d.lang.toUpperCase());
      console.log(`run ${i}: deepgram_lang=${d.lang.padEnd(5)} [${label}]  bytes=${out.byteLength}  gemini_out_text="${geminiText.slice(0, 50)}"  dg_text="${d.text}"`);
    } catch (e) { console.log(`run ${i}: ERROR ${e instanceof Error ? e.message : String(e)}`); }
  }
  console.log(`\n=== deterministic result over ${N} runs ===`);
  console.log(`SPANISH(translated)=${spanish}  ENGLISH(echo)=${english}  other=${other}  empty=${empty}`);
  console.log(english === 0 && spanish > 0
    ? "→ Output audio is consistently Spanish. The 'flake' was the SMOKE'S VERIFIER, not the model."
    : `→ Real model echo rate: ${english}/${N}. Model/config flake confirmed.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
