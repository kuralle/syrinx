// The Quickstart's "Kuralle Agents" tab, verbatim, behind the Quickstart's server.
import { randomUUID } from "node:crypto";
import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import { defineAgent, createRuntime, MemoryStore } from "@kuralle-agents/core";
import { createOpenAI } from "@ai-sdk/openai";
import { createVoiceWebSocketServer } from "@kuralle-syrinx/server-websocket";
import { ensureRepoRootDotenv } from "../src/run-one-turn.js";

ensureRepoRootDotenv();

const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

const agent = defineAgent({
  id: "assistant",
  model: openai("gpt-4.1-mini"),
  instructions: "You are a helpful voice assistant. Keep your replies short.",
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: "assistant",
  sessionStore: new MemoryStore(),
});

export function createVoiceAgent(): VoiceAgentSession {
  const sessionId = randomUUID();

  const session = new VoiceAgentSession({
    plugins: {
      stt: {
        api_key: process.env["DEEPGRAM_API_KEY"] ?? "",
        model: "nova-3",
        sample_rate: 16000,
        emit_eos_on_final: true,
      },
      bridge: {},
      tts: { api_key: process.env["CARTESIA_API_KEY"] ?? "" },
    },
    endpointingOwner: "provider_stt",
  });

  session.registerPlugin("stt", new DeepgramSTTPlugin());
  session.registerPlugin(
    "bridge",
    new ReasoningBridge(fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, { sessionId })),
  );
  session.registerPlugin("tts", new CartesiaTTSPlugin());

  return session;
}

await createVoiceWebSocketServer({
  port: 4174,
  path: "/ws",
  createSession: () => createVoiceAgent(),
});

console.log("kuralle agent listening on ws://localhost:4174/ws");
