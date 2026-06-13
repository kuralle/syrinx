// SPDX-License-Identifier: MIT
//
// Live proof for #9: a TYPED user turn (no audio) reaches gemini-3.1-flash-live-preview through the
// real shipped path — user.text_received → RealtimeBridge → adapter.sendText (sendClientContent) — and
// the model answers with audio + an assistant transcript.

import {
  Route,
  VoiceAgentSession,
  type LlmDeltaPacket,
  type LlmResponseDonePacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
} from "@kuralle-syrinx/core";
import { RealtimeBridge, fromGeminiLive } from "@kuralle-syrinx/realtime";

import { ensureRepoRootDotenv } from "../src/run-one-turn.js";

const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const TYPED_TURN = "In one short sentence, what is the capital of France?";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["GEMINI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing GEMINI_API_KEY in repo-root .env");

  const adapter = fromGeminiLive({ apiKey, model: GEMINI_LIVE_MODEL });
  const bridge = new RealtimeBridge(adapter);
  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);

  const audioByContext = new Map<string, Uint8Array[]>();
  const assistantByContext = new Map<string, string>();
  const deltas: string[] = [];
  const userTranscripts: string[] = [];

  session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    const list = audioByContext.get(pkt.contextId) ?? [];
    list.push(pkt.audio);
    audioByContext.set(pkt.contextId, list);
  });
  session.bus.on<LlmDeltaPacket>("llm.delta", (pkt) => {
    deltas.push(pkt.text);
  });
  session.bus.on<LlmResponseDonePacket>("llm.done", (pkt) => {
    assistantByContext.set(pkt.contextId, pkt.text);
  });
  session.bus.on<SttResultPacket>("stt.result", (pkt) => {
    userTranscripts.push(pkt.text);
  });

  const ttsEnd = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("typed-turn tts.end timeout (60s)")), 60_000);
    const off = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      clearTimeout(timeout);
      off();
      resolve(pkt.contextId);
    });
  });

  await session.start();

  // The whole point of #9: a typed turn, no audio frames at all.
  session.bus.push(Route.Main, {
    kind: "user.text_received",
    contextId: crypto.randomUUID(),
    timestampMs: Date.now(),
    text: TYPED_TURN,
  });

  const ctx = await ttsEnd;
  await sleep(200);

  // Sum audio across every context this turn spanned (Gemini mints response_started on
  // setupComplete and again on the first model part, so the spoken answer can land on a
  // sibling contextId of the one that fired tts.end).
  const audioBytes = [...audioByContext.values()]
    .flat()
    .reduce((sum, c) => sum + c.byteLength, 0);
  const assistantText = [...assistantByContext.values()].join(" ").trim() || deltas.join(" ").trim();
  const mentionsParis = assistantText.toLowerCase().includes("paris");

  // The #9 contract: a typed turn (no audio input) makes the front model speak. Audio is the
  // hard gate — it proves sendText (sendClientContent) reached the live model and it generated a turn.
  if (audioBytes === 0) {
    throw new Error(`typed turn produced no audio — sendText did not reach the model (ctx=${ctx})`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      model: GEMINI_LIVE_MODEL,
      typedTurn: TYPED_TURN,
      contextId: ctx,
      audioBytes,
      assistantText,
      mentionsParis,
      userTranscripts,
    }),
  );

  await session.close();
  await adapter.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
