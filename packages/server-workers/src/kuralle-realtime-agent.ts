// SPDX-License-Identifier: MIT

import { createOpenAI } from "@ai-sdk/openai";
import {
  defineAgent,
  defineFlow,
  defineTool,
  buildToolSet,
  createRuntime,
  MemoryStore,
  reply,
  type Runtime,
} from "@kuralle-agents/core";
import {
  AiSdkEmbedder,
  VectorRetriever,
  type VectorStoreCore,
} from "@kuralle-agents/rag";
import { defineSkill } from "@kuralle-agents/skills";
import { CloudflareVectorizeStore, type VectorizeBinding } from "@kuralle-agents/vectorize-store";
import type { VectorizeIndex } from "@cloudflare/workers-types";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import type { Reasoner } from "@kuralle-syrinx/core";
import { z } from "zod";

const DEFAULT_MODEL = "gpt-4.1-mini";
const INDEX_NAME = "kuralle-university-kb";

const SCHOLARSHIP_SKILL = defineSkill({
  name: "scholarship-guidance",
  description: "Guide students through scholarship eligibility and application steps",
  body: `# Scholarship Guidance

1. Ask whether the student is seeking merit-based aid, need-based aid, or both.
2. For merit: cite the Dean's Merit Scholarship (GPA ≥ 3.5).
3. For need: cite the Need-Based Grant (FAFSA required).
4. Always mention the application deadline of February 15.`,
  allowedTools: [],
});

let bookingCounter = 0;

const createBookingTool = defineTool({
  name: "create_booking",
  description: "Finalize the advisor appointment booking. Only call after the user has explicitly confirmed the details.",
  input: z.object({}),
  execute: async () => {
    bookingCounter += 1;
    return { bookingRef: `ADV-${bookingCounter}` };
  },
});

const recordBookingDetails = defineTool({
  name: "record_booking_details",
  description: "Record the student's name, program, and preferred date once all three are known.",
  input: z.object({ name: z.string(), program: z.string(), preferredDate: z.string() }),
  execute: async (details) => details,
});

const requestTranscriptTool = defineTool({
  name: "request_transcript",
  description: "Submit an official transcript request for the given studentId.",
  input: z.object({ studentId: z.string() }),
  execute: async ({ studentId }) => ({ requestRef: `TR-${studentId}` }),
});

const replyBooked = reply({
  id: "reply-booked",
  grounding: { knowledge: { autoRetrieve: false } },
  instructions: ({ state }) =>
    `The advisor appointment is booked. Confirm it to the user and include this exact reference verbatim: ${String(state["bookingRef"] ?? "")}.`,
  next: () => ({ end: "booked" }),
});

const confirmBooking = reply({
  id: "confirm-booking",
  grounding: { knowledge: { autoRetrieve: false } },
  instructions: ({ state }) =>
    `Summarize the advisor appointment — name: ${String(state["name"] ?? "")}, program: ${String(state["program"] ?? "")}, date: ${String(state["preferredDate"] ?? "")} — and ask the user to confirm. ONLY when the user clearly confirms, call create_booking to finalize. If they want changes, ask for the corrected detail.`,
  tools: buildToolSet({ create_booking: createBookingTool }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === "create_booking");
    if (r?.result && typeof r.result === "object") return { goto: replyBooked, data: r.result as Record<string, unknown> };
    return "stay";
  },
});

const collectBooking = reply({
  id: "collect-booking",
  grounding: { knowledge: { autoRetrieve: false } },
  instructions:
    "Help the user book an advisor appointment. If you don't yet have all three of name, program, and preferred date, ask for the missing ones. Once you have all three, call record_booking_details.",
  tools: buildToolSet({ record_booking_details: recordBookingDetails }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === "record_booking_details");
    if (r?.result && typeof r.result === "object") return { goto: confirmBooking, data: r.result as Record<string, unknown> };
    return "stay";
  },
});

const bookingFlow = defineFlow({
  name: "book-advisor-appointment",
  description: "Book an appointment with an academic advisor",
  start: collectBooking,
  nodes: [collectBooking, confirmBooking, replyBooked],
});

const replyTranscript = reply({
  id: "reply-transcript",
  grounding: { knowledge: { autoRetrieve: false } },
  instructions: ({ state }) =>
    `Confirm the transcript request was submitted. Include this exact request reference verbatim: ${String(state["requestRef"] ?? "")}.`,
  next: () => ({ end: "requested" }),
});

const collectTranscript = reply({
  id: "collect-transcript",
  grounding: { knowledge: { autoRetrieve: false } },
  instructions:
    "Help the user request an official transcript. If you don't have their student ID, ask for it. Once you have it, call request_transcript with that studentId.",
  tools: buildToolSet({ request_transcript: requestTranscriptTool }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === "request_transcript");
    if (r?.result && typeof r.result === "object") return { goto: replyTranscript, data: r.result as Record<string, unknown> };
    return "stay";
  },
});

const transcriptFlow = defineFlow({
  name: "request-transcript",
  description: "Request an official academic transcript",
  start: collectTranscript,
  nodes: [collectTranscript, replyTranscript],
});

export interface KuralleRealtimeEnv {
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_MODEL?: string;
  readonly VECTORIZE: VectorizeIndex;
}

export interface CreateRealtimeKuralleReasonerOptions {
  readonly sessionId: string;
  readonly userId?: string;
}

let runtimePromise: Promise<Runtime> | undefined;

function vectorStore(env: KuralleRealtimeEnv): VectorStoreCore {
  return new CloudflareVectorizeStore({ binding: env.VECTORIZE as unknown as VectorizeBinding });
}

async function createUniversityRuntime(env: KuralleRealtimeEnv): Promise<Runtime> {
  const apiKey = requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  const openai = createOpenAI({ apiKey });
  const model = openai(env.OPENAI_MODEL?.trim() || DEFAULT_MODEL);
  const embedder = new AiSdkEmbedder({ model: openai.embedding("text-embedding-3-small") });
  const retriever = new VectorRetriever({
    vectorStore: vectorStore(env),
    embedder,
    indexName: INDEX_NAME,
    topK: 3,
  });

  const agent = defineAgent({
    id: "university",
    model,
    instructions:
      "You are a friendly university support assistant. Answer admissions, program, tuition, and scholarship questions clearly and concisely for voice.",
    knowledge: { autoRetrieve: true },
    skills: [SCHOLARSHIP_SKILL],
    flows: [bookingFlow, transcriptFlow],
    tools: {
      create_booking: createBookingTool,
      request_transcript: requestTranscriptTool,
    },
    memory: { workingMemory: { autoLoad: [{ scope: "user", key: "USER" }] } },
  });

  return createRuntime({
    agents: [agent],
    defaultAgentId: "university",
    sessionStore: new MemoryStore(),
    knowledge: { retriever, embedder },
  });
}

function getRuntime(env: KuralleRealtimeEnv): Promise<Runtime> {
  return (runtimePromise ??= createUniversityRuntime(env));
}

export async function createRealtimeKuralleReasoner(
  env: KuralleRealtimeEnv,
  opts: CreateRealtimeKuralleReasonerOptions,
): Promise<Reasoner> {
  const runtime = await getRuntime(env);
  return fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, {
    sessionId: opts.sessionId,
    userId: opts.userId ?? "voice",
  });
}

export type KuralleCascadeEnv = KuralleRealtimeEnv;
export type CreateCascadeKuralleReasonerOptions = CreateRealtimeKuralleReasonerOptions;
export const createCascadeKuralleReasoner = createRealtimeKuralleReasoner;

function requireKey(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required to start a realtime voice session`);
  return trimmed;
}
