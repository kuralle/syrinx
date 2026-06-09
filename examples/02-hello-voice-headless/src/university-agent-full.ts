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
  InMemoryVectorStore,
  VectorRetriever,
  createMarkdownChunker,
  createStaticKnowledgeSource,
} from "@kuralle-agents/rag";
import { defineSkill } from "@kuralle-agents/skills";
import { z } from "zod";

import { DEFAULT_MODEL } from "./run-one-turn.js";

const CORPUS: ReadonlyArray<{ id: string; name: string; content: string }> = [
  {
    id: "admissions",
    name: "Admissions",
    content: `# Admissions

## Computer Science Masters Application

The application deadline for the computer science masters program is **March 31**.

### Required Documents
- Official transcript
- Statement of purpose (SOP)
- Two letters of recommendation
`,
  },
  {
    id: "cs-program",
    name: "CS Program",
    content: `# Computer Science Masters

The CS masters program requires **30 credits** to graduate.

## Prerequisites
- Data structures
- Linear algebra

GRE scores are optional for admission.
`,
  },
  {
    id: "tuition",
    name: "Tuition",
    content: `# Tuition and Fees

In-state tuition is **$15,000 per semester**.

Mandatory fees are **$800** per semester.
`,
  },
  {
    id: "scholarships",
    name: "Scholarships",
    content: `# Scholarships

## Dean's Merit Scholarship
Awarded to students with GPA **≥ 3.5**.

## Need-Based Grant
Requires a completed **FAFSA**.

The scholarship application deadline is **February 15**.
`,
  },
];

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

// Canonical kuralle flow pattern (see restaurant-reservation example): reply nodes
// with tools + a next(turn) that inspects toolResults, looping on 'stay' to wait for
// each user turn. Avoids the collect/confirmGate same-turn input-consumption pitfall.

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

export interface FullUniversityRuntime {
  readonly runtime: Runtime;
  readonly ingestMs: number;
}

export interface FullUniversityRuntimeOptions {
  /** true (guaranteed) = pre-inject RAG every answering turn; false (on-demand) = wire a
   *  knowledge_search tool the model calls only when answering (routing turns pay no tax). */
  readonly autoRetrieve?: boolean;
}

export async function createFullUniversityRuntime(
  opts: FullUniversityRuntimeOptions = {},
): Promise<FullUniversityRuntime> {
  const autoRetrieve = opts.autoRetrieve ?? true;
  const apiKey = requireEnv("OPENAI_API_KEY");
  const openai = createOpenAI({ apiKey });
  const model = openai(process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL);
  const embedder = new AiSdkEmbedder({ model: openai.embedding("text-embedding-3-small") });
  const store = new InMemoryVectorStore();

  await store.createIndex({ indexName: "university-kb", dimension: 1536 });

  const ingestStart = performance.now();
  const chunker = createMarkdownChunker();
  for (const doc of CORPUS) {
    const src = createStaticKnowledgeSource({
      id: doc.id,
      name: doc.name,
      content: doc.content,
      chunker,
    });
    const chunks = src.getChunks();
    const vecs = await embedder.embedMany(chunks.map((c) => c.text));
    await store.upsert(
      "university-kb",
      chunks.map((c, i) => ({
        id: `${doc.id}:${c.id}`,
        vector: vecs[i]!,
        document: c.text,
        metadata: { sourceId: doc.id },
      })),
    );
  }
  const ingestMs = performance.now() - ingestStart;

  const retriever = new VectorRetriever({
    vectorStore: store,
    embedder,
    indexName: "university-kb",
    topK: 3,
  });

  const agent = defineAgent({
    id: "university",
    model,
    instructions:
      "You are a friendly university support assistant. Answer admissions, program, tuition, and scholarship questions clearly and concisely for voice.",
    knowledge: { autoRetrieve },
    skills: [SCHOLARSHIP_SKILL],
    flows: [bookingFlow, transcriptFlow],
    tools: {
      create_booking: createBookingTool,
      request_transcript: requestTranscriptTool,
    },
    memory: { workingMemory: { autoLoad: [{ scope: "user", key: "USER" }] } },
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: "university",
    sessionStore: new MemoryStore(),
    knowledge: { retriever, embedder },
  });

  return { runtime, ingestMs };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
