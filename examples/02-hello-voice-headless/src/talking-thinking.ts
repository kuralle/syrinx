// SPDX-License-Identifier: MIT
//
// The talking–thinking (responder–thinker) model: a fast realtime front does the
// talking; a background reasoner does the deep thinking. The front stays the voice
// the caller hears, and delegates real questions to the reasoner through a tool.
//
// See docs: /guides/talking-thinking

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime, type RealtimeToolDef } from "@kuralle-syrinx/realtime";
import { fromStreamText } from "@kuralle-syrinx/aisdk";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";
import { createOpenAI } from "@ai-sdk/openai";

// The tool the front advertises. When the front decides a turn needs grounded
// knowledge, it calls this tool — and the bridge routes the query to the thinker.
const CONSULT_TOOL: RealtimeToolDef = {
  name: "consult_knowledge",
  description:
    "Look up grounded, factual answers. Call this for real questions; answer greetings and small talk directly.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The user's question, self-contained." } },
    required: ["query"],
  },
};

export function createTalkingThinkingAgent(): VoiceAgentSession {
  const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

  // The thinker: a deep reasoner. AI SDK here; swap for a kuralle RAG agent or Mastra.
  const thinker = fromStreamText({
    model: openai("gpt-4.1"),
    system: "Answer the user's question with grounded facts. Be concise.",
  });

  // The talker: a realtime front that advertises the consult tool.
  const front = fromOpenAIRealtime({
    apiKey: process.env["OPENAI_API_KEY"]!,
    socketFactory: createNodeWsSocket,
    tools: [CONSULT_TOOL],
  });

  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer", // the realtime front owns its own turn detection
  });

  // The bridge delegates CONSULT_TOOL calls to the thinker, then feeds the answer
  // back to the front as an authoritative tool result — the front speaks it faithfully.
  session.registerPlugin("realtime", new RealtimeBridge(front, thinker, CONSULT_TOOL.name));

  // Show a "thinking…" indicator only when the background agent is actually slow.
  session.on("tool_call_cue", (cue) => {
    if (cue.phase === "delayed") console.log("thinking…");
  });

  return session;
}
